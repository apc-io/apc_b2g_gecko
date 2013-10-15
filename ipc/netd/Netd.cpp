/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "Netd.h"
#include <android/log.h>
#include <cutils/sockets.h>
#include <fcntl.h>
#include <sys/socket.h>

#include "cutils/properties.h"
#include "android/log.h"

#include "nsWhitespaceTokenizer.h"
#include "nsXULAppAPI.h"
#include "nsAutoPtr.h"
#include "nsString.h"
#include "nsThreadUtils.h"


#define LOG(args...)  __android_log_print(ANDROID_LOG_INFO, "Gonk", args)
#define ICS_SYS_USB_RNDIS_MAC "/sys/class/android_usb/android0/f_rndis/ethaddr"
#define INVALID_SOCKET -1
#define MAX_RECONNECT_TIMES 10

namespace {

mozilla::RefPtr<mozilla::ipc::NetdClient> gNetdClient;
mozilla::RefPtr<mozilla::ipc::NetdConsumer> gNetdConsumer;

class StopNetdConsumer : public nsRunnable {
public:
  NS_IMETHOD Run()
  {
    MOZ_ASSERT(NS_IsMainThread());

    gNetdConsumer = nullptr;
    return NS_OK;
  }
};

bool
InitRndisAddress()
{
  char mac[20];
  char serialno[] = "1234567890ABCDEF";
  static const int kEthernetAddressLength = 6;
  char address[kEthernetAddressLength];
  int i = 0;
  int ret = 0;
  int length = 0;
  mozilla::ScopedClose fd;

  fd.rwget() = open(ICS_SYS_USB_RNDIS_MAC, O_WRONLY);
  if (fd.rwget() == -1) {
    LOG("Unable to open file %s.", ICS_SYS_USB_RNDIS_MAC);
    return false;
  }

  property_get("ro.serialno", serialno, "1234567890ABCDEF");

  memset(address, 0, sizeof(address));
  // First byte is 0x02 to signify a locally administered address.
  address[0] = 0x02;
  length = strlen(serialno);
  for (i = 0; i < length; i++) {
    address[i % (kEthernetAddressLength - 1) + 1] ^= serialno[i];
  }

  sprintf(mac, "%02x:%02x:%02x:%02x:%02x:%02x",
          address[0], address[1], address[2],
          address[3], address[4], address[5]);
  length = strlen(mac);
  ret = write(fd.get(), mac, length);
  if (ret != length) {
    LOG("Fail to write file %s.", ICS_SYS_USB_RNDIS_MAC);
    return false;
  }
  return true;
}

} // anonymous namespace

namespace mozilla {
namespace ipc {

NetdClient::NetdClient()
  : mSocket(INVALID_SOCKET)
  , mIOLoop(MessageLoopForIO::current())
  , mCurrentWriteOffset(0)
  , mReceivedIndex(0)
  , mReConnectTimes(0)
{
  MOZ_COUNT_CTOR(NetdClient);
}

NetdClient::~NetdClient()
{
  MOZ_COUNT_DTOR(NetdClient);
}

bool
NetdClient::OpenSocket()
{
  mSocket.rwget() = socket_local_client("netd",
                                        ANDROID_SOCKET_NAMESPACE_RESERVED,
                                        SOCK_STREAM);
  if (mSocket.rwget() < 0) {
    LOG("Error connecting to : netd (%s) - will retry", strerror(errno));
    return false;
  }
  // Add FD_CLOEXEC flag.
  int flags = fcntl(mSocket.get(), F_GETFD);
  if (flags == -1) {
    LOG("Error doing fcntl with F_GETFD command(%s)", strerror(errno));
    return false;
  }
  flags |= FD_CLOEXEC;
  if (fcntl(mSocket.get(), F_SETFD, flags) == -1) {
    LOG("Error doing fcntl with F_SETFD command(%s)", strerror(errno));
    return false;
  }
  // Set non-blocking.
  if (fcntl(mSocket.get(), F_SETFL, O_NONBLOCK) == -1) {
    LOG("Error set non-blocking socket(%s)", strerror(errno));
    return false;
  }
  if (!MessageLoopForIO::current()->
      WatchFileDescriptor(mSocket.get(),
                          true,
                          MessageLoopForIO::WATCH_READ,
                          &mReadWatcher,
                          this)) {
    LOG("Error set socket read watcher(%s)", strerror(errno));
    return false;
  }

  if (!mOutgoingQ.empty()) {
    MessageLoopForIO::current()->
      WatchFileDescriptor(mSocket.get(),
                          false,
                          MessageLoopForIO::WATCH_WRITE,
                          &mWriteWatcher,
                          this);
  }

  LOG("Connected to netd");
  return true;
}

void
NetdClient::OnFileCanReadWithoutBlocking(int aFd)
{
  ssize_t length = 0;

  MOZ_ASSERT(aFd == mSocket.get());
  while (true) {
    errno = 0;
    MOZ_ASSERT(mReceivedIndex < MAX_COMMAND_SIZE);
    length = read(aFd, &mReceiveBuffer[mReceivedIndex], MAX_COMMAND_SIZE - mReceivedIndex);
    MOZ_ASSERT(length <= ssize_t(MAX_COMMAND_SIZE - mReceivedIndex));
    if (length <= 0) {
      if (length == -1) {
        if (errno == EINTR) {
          continue; // retry system call when interrupted
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
          return; // no data available: return and re-poll
        }
      }
      LOG("Can't read from netd error: %d (%s) length: %d", errno, strerror(errno), length);
      // At this point, assume that we can't actually access
      // the socket anymore, and start a reconnect loop.
      Restart();
      return;
    }

    while (length-- > 0) {
      MOZ_ASSERT(mReceivedIndex < MAX_COMMAND_SIZE);
      if (mReceiveBuffer[mReceivedIndex] == '\0') {
        // We found a line terminator. Each line is formatted as an
        // integer response code followed by the rest of the line.
        // Fish out the response code.
        errno = 0;
        int responseCode = strtol(mReceiveBuffer, nullptr, 10);
        // TODO, Bug 783966, handle InterfaceChange(600) and BandwidthControl(601).
        if (!errno) {
          NetdCommand* response = new NetdCommand();
          // Passing all the response message, including the line terminator.
          response->mSize = mReceivedIndex + 1;
          memcpy(response->mData, mReceiveBuffer, mReceivedIndex + 1);
          gNetdConsumer->MessageReceived(response);
        }
        if (!responseCode || errno) {
          LOG("Can't parse netd's response: %d (%s)", errno, strerror(errno));
        }
        // There is data in the receive buffer beyond the current line.
        // Shift it down to the beginning.
        if (length > 0) {
          MOZ_ASSERT(mReceivedIndex < (MAX_COMMAND_SIZE - 1));
          memmove(&mReceiveBuffer[0], &mReceiveBuffer[mReceivedIndex + 1], length);
        }
        mReceivedIndex = 0;
      } else {
        mReceivedIndex++;
      }
    }
  }
}

void
NetdClient::OnFileCanWriteWithoutBlocking(int aFd)
{
  MOZ_ASSERT(aFd == mSocket.get());
  WriteNetdCommand();
}

void
NetdClient::Restart()
{
  MOZ_ASSERT(MessageLoop::current() == XRE_GetIOMessageLoop());

  mReadWatcher.StopWatchingFileDescriptor();
  mWriteWatcher.StopWatchingFileDescriptor();

  mSocket.dispose();
  mReceivedIndex = 0;
  mCurrentWriteOffset = 0;
  mCurrentNetdCommand = nullptr;
  while (!mOutgoingQ.empty()) {
    delete mOutgoingQ.front();
    mOutgoingQ.pop();
  }
  Start();
}

// static
void
NetdClient::Start()
{
  MOZ_ASSERT(MessageLoop::current() == XRE_GetIOMessageLoop());

  if (!gNetdClient) {
    LOG("Netd Client is not initialized");
    return;
  }

  if (!gNetdClient->OpenSocket()) {
    // Socket open failed, try again in a second.
    LOG("Fail to connect to Netd");
    if (++gNetdClient->mReConnectTimes > MAX_RECONNECT_TIMES) {
      LOG("Fail to connect to Netd after retry %d times", MAX_RECONNECT_TIMES);
      return;
    }

    MessageLoopForIO::current()->
      PostDelayedTask(FROM_HERE,
                      NewRunnableFunction(NetdClient::Start),
                      1000);
    return;
  }
  gNetdClient->mReConnectTimes = 0;
}

// static
void
NetdClient::SendNetdCommandIOThread(NetdCommand* aMessage)
{
  MOZ_ASSERT(MessageLoop::current() == XRE_GetIOMessageLoop());
  MOZ_ASSERT(aMessage);

  if (!gNetdClient) {
    LOG("Netd Client is not initialized");
    return;
  }

  gNetdClient->mOutgoingQ.push(aMessage);

  if (gNetdClient->mSocket.get() == INVALID_SOCKET) {
    LOG("Netd connection is not established, push the message to queue");
    return;
  }

  gNetdClient->WriteNetdCommand();
}

void
NetdClient::WriteNetdCommand()
{
  if (!mCurrentNetdCommand) {
    mCurrentWriteOffset = 0;
    mCurrentNetdCommand = mOutgoingQ.front();
    mOutgoingQ.pop();
  }

  while (mCurrentWriteOffset < mCurrentNetdCommand->mSize) {
    ssize_t write_amount = mCurrentNetdCommand->mSize - mCurrentWriteOffset;
    ssize_t written = write(mSocket.get(),
                            mCurrentNetdCommand->mData + mCurrentWriteOffset,
                            write_amount);
    if (written < 0) {
      LOG("Cannot write to network, error %d\n", (int) written);
      Restart();
      return;
    }

    if (written > 0) {
      mCurrentWriteOffset += written;
    }

    if (written != write_amount) {
      LOG("WriteNetdCommand fail !!! Write is not completed");
      break;
    }
  }

  if (mCurrentWriteOffset != mCurrentNetdCommand->mSize) {
    MessageLoopForIO::current()->
      WatchFileDescriptor(mSocket.get(),
                          false,
                          MessageLoopForIO::WATCH_WRITE,
                          &mWriteWatcher,
                          this);
    return;
  }

  mCurrentNetdCommand = nullptr;
}

static void
InitNetdIOThread()
{
  bool result;
  char propValue[PROPERTY_VALUE_MAX];

  MOZ_ASSERT(MessageLoop::current() == XRE_GetIOMessageLoop());
  MOZ_ASSERT(!gNetdClient);

  property_get("ro.build.version.sdk", propValue, "0");
  // Assign rndis address for usb tethering in ICS.
  if (atoi(propValue) >= 15) {
    result = InitRndisAddress();
    // We don't return here because InitRnsisAddress() function is related to
    // usb tethering only. Others service such as wifi tethering still need
    // to use ipc to communicate with netd.
    if (!result) {
      LOG("fail to give rndis interface an address");
    }
  }
  gNetdClient = new NetdClient();
  gNetdClient->Start();
}

static void
ShutdownNetdIOThread()
{
  MOZ_ASSERT(MessageLoop::current() == XRE_GetIOMessageLoop());
  nsCOMPtr<nsIRunnable> shutdownEvent = new StopNetdConsumer();

  gNetdClient = nullptr;

  NS_DispatchToMainThread(shutdownEvent);
}

void
StartNetd(NetdConsumer* aNetdConsumer)
{
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(aNetdConsumer);
  MOZ_ASSERT(gNetdConsumer == nullptr);

  gNetdConsumer = aNetdConsumer;
  XRE_GetIOMessageLoop()->PostTask(
    FROM_HERE,
    NewRunnableFunction(InitNetdIOThread));
}

void
StopNetd()
{
  MOZ_ASSERT(NS_IsMainThread());

  nsIThread* currentThread = NS_GetCurrentThread();
  NS_ASSERTION(currentThread, "This should never be null!");

  XRE_GetIOMessageLoop()->PostTask(
    FROM_HERE,
    NewRunnableFunction(ShutdownNetdIOThread));

  while (gNetdConsumer) {
    if (!NS_ProcessNextEvent(currentThread)) {
      NS_WARNING("Something bad happened!");
      break;
    }
  }
}

/**************************************************************************
*
*   This function runs in net worker Thread context. The net worker thread
*   is created in dom/system/gonk/NetworkManager.js
*
**************************************************************************/
void
SendNetdCommand(NetdCommand* aMessage)
{
  MOZ_ASSERT(aMessage);

  XRE_GetIOMessageLoop()->PostTask(
    FROM_HERE,
    NewRunnableFunction(NetdClient::SendNetdCommandIOThread, aMessage));
}

} // namespace ipc
} // namespace mozilla
