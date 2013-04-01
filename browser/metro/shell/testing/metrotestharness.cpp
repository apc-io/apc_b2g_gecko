/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#undef WINVER
#undef _WIN32_WINNT
#define WINVER 0x602
#define _WIN32_WINNT 0x602

#include <windows.h>
#include <objbase.h>
#include <combaseapi.h>
#include <atlcore.h>
#include <atlstr.h>
#include <wininet.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <propkey.h>
#include <propvarutil.h>
#include <stdio.h>
#include <stdlib.h>
#include <strsafe.h>
#include <io.h>
#include <shellapi.h>

static const WCHAR* kFirefoxExe = L"firefox.exe";
static const WCHAR* kDefaultMetroBrowserIDPathKey = L"FirefoxURL";
static const WCHAR* kDemoMetroBrowserIDPathKey = L"Mozilla.Firefox.URL";

CString sAppParams;
CString sFirefoxPath;

// The tests file we write out for firefox.exe which contains test
// startup command line paramters.
#define kMetroTestFile "tests.ini"

static void Log(const wchar_t *fmt, ...)
{
  va_list a = NULL;
  wchar_t szDebugString[1024];
  if(!lstrlenW(fmt))
    return;
  va_start(a,fmt);
  vswprintf(szDebugString, 1024, fmt, a);
  va_end(a);
  if(!lstrlenW(szDebugString))
    return;

  wprintf(L"INFO | metrotestharness.exe | %s\n", szDebugString);
  fflush(stdout);
}

static void Fail(const wchar_t *fmt, ...)
{
  va_list a = NULL;
  wchar_t szDebugString[1024];
  if(!lstrlenW(fmt))
    return;
  va_start(a,fmt);
  vswprintf(szDebugString, 1024, fmt, a);
  va_end(a);
  if(!lstrlenW(szDebugString))
    return;

  wprintf(L"TEST-UNEXPECTED-FAIL | metrotestharness.exe | %s\n", szDebugString);
  fflush(stdout);
}

/*
 * Retrieve our module dir path.
 *
 * @aPathBuffer Buffer to fill
 */
static bool GetModulePath(CStringW& aPathBuffer)
{
  WCHAR buffer[MAX_PATH];
  memset(buffer, 0, sizeof(buffer));

  if (!GetModuleFileName(NULL, buffer, MAX_PATH)) {
    Fail(L"GetModuleFileName failed.");
    return false;
  }

  WCHAR* slash = wcsrchr(buffer, '\\');
  if (!slash)
    return false;
  *slash = '\0';

  aPathBuffer = buffer;
  return true;
}

/*
 * Retrieve 'module dir path\firefox.exe'
 *
 * @aPathBuffer Buffer to fill
 */
static bool GetDesktopBrowserPath(CStringW& aPathBuffer)
{
  if (!GetModulePath(aPathBuffer))
    return false;

  // ceh.exe sits in dist/bin root with the desktop browser. Since this
  // is a firefox only component, this hardcoded filename is ok.
  aPathBuffer.Append(L"\\");
  aPathBuffer.Append(kFirefoxExe);
  return true;
}

/*
 * Retrieve the app model id of the firefox metro browser.
 *
 * @aPathBuffer Buffer to fill
 * @aCharLength Length of buffer to fill in characters
 */
static bool GetDefaultBrowserAppModelID(WCHAR* aIDBuffer,
                                        long aCharLength)
{
  if (!aIDBuffer || aCharLength <= 0)
    return false;

  memset(aIDBuffer, 0, (sizeof(WCHAR)*aCharLength));

  HKEY key;
  if (RegOpenKeyExW(HKEY_CLASSES_ROOT, kDefaultMetroBrowserIDPathKey,
                    0, KEY_READ, &key) != ERROR_SUCCESS) {
    if (RegOpenKeyExW(HKEY_CLASSES_ROOT, kDemoMetroBrowserIDPathKey,
                      0, KEY_READ, &key) != ERROR_SUCCESS) {
      return false;
    }
  }
  DWORD len = aCharLength * sizeof(WCHAR);
  memset(aIDBuffer, 0, len);
  if (RegQueryValueExW(key, L"AppUserModelID", NULL, NULL,
                       (LPBYTE)aIDBuffer, &len) != ERROR_SUCCESS || !len) {
    RegCloseKey(key);
    return false;
  }
  RegCloseKey(key);
  return true;
}

// Tests.ini file cleanup helper
class DeleteTestFileHelper
{
  CStringA mTestFile;
public:
  DeleteTestFileHelper(CStringA& aTestFile) :
    mTestFile(aTestFile) {}
  ~DeleteTestFileHelper() {
    if (mTestFile.GetLength()) {
      Log(L"Deleting %s", CStringW(mTestFile));
      DeleteFileA(mTestFile);
    }
  }
};

static void AddConsoleIdToParams()
{
  DWORD dwId = GetCurrentProcessId();
  CString tmp;
  tmp.Format(L" testconsoleid=%d", dwId);
  sAppParams += tmp;
}

static bool Launch()
{
  Log(L"Launching browser...");

  DWORD processID;

  // The interface that allows us to activate the browser
  CComPtr<IApplicationActivationManager> activateMgr;
  if (FAILED(CoCreateInstance(CLSID_ApplicationActivationManager, NULL,
                              CLSCTX_LOCAL_SERVER,
                              IID_IApplicationActivationManager,
                              (void**)&activateMgr))) {
    Fail(L"CoCreateInstance CLSID_ApplicationActivationManager failed.");
    return false;
  }
  
  HRESULT hr;
  WCHAR appModelID[256];
  // Activation is based on the browser's registered app model id
  if (!GetDefaultBrowserAppModelID(appModelID, (sizeof(appModelID)/sizeof(WCHAR)))) {
    Fail(L"GetDefaultBrowserAppModelID failed.");
    return false;
  }
  Log(L"App model id='%s'", appModelID);

  // Hand off focus rights to the out-of-process activation server. Without
  // this the metro interface won't launch.
  hr = CoAllowSetForegroundWindow(activateMgr, NULL);
  if (FAILED(hr)) {
    Fail(L"CoAllowSetForegroundWindow result %X", hr);
    return false;
  }

  Log(L"Harness process id: %d", GetCurrentProcessId());

  // Because we can't pass command line args, we store params in a
  // tests.ini file in dist/bin which the browser picks up on launch.
  CStringA testFilePath;
  if (sFirefoxPath.GetLength()) {
    // Use the firefoxpath passed to us by the test harness
    int index = sFirefoxPath.ReverseFind('\\');
    if (index == -1) {
      Fail(L"Bad firefoxpath path");
      return false;
    }
    testFilePath = sFirefoxPath.Mid(0, index);
    testFilePath += "\\";
    testFilePath += kMetroTestFile;
  } else {
    // Use the module path
    char path[MAX_PATH];
    if (!GetModuleFileNameA(NULL, path, MAX_PATH)) {
      Fail(L"GetModuleFileNameA errorno=%d", GetLastError());
      return false;
    }
    char* slash = strrchr(path, '\\');
    if (!slash)
      return false;
    *slash = '\0'; // no trailing slash
    testFilePath = path;
    testFilePath += "\\";
    testFilePath += kMetroTestFile;
  }

  Log(L"Writing out tests.ini to: '%s'", CStringW(testFilePath));
  HANDLE hTestFile = CreateFileA(testFilePath, GENERIC_WRITE,
                                 0, NULL, CREATE_ALWAYS,
                                 FILE_ATTRIBUTE_NORMAL,
                                 NULL);
  if (hTestFile == INVALID_HANDLE_VALUE) {
    Fail(L"CreateFileA errorno=%d", GetLastError());
    return false;
  }

  DeleteTestFileHelper dtf(testFilePath);

  CStringA asciiParams = sAppParams;
  if (!WriteFile(hTestFile, asciiParams, asciiParams.GetLength(), NULL, 0)) {
    CloseHandle(hTestFile);
    Fail(L"WriteFile errorno=%d", GetLastError());
    return false;
  }
  FlushFileBuffers(hTestFile);
  CloseHandle(hTestFile);

  // Launch firefox
  hr = activateMgr->ActivateApplication(appModelID, L"", AO_NOERRORUI, &processID);
  if (FAILED(hr)) {
    Fail(L"ActivateApplication result %X", hr);
    return false;
  }

  Log(L"Activation succeeded. processid=%d", processID);

  HANDLE child = OpenProcess(SYNCHRONIZE, FALSE, processID);
  if (!child) {
    Fail(L"Couldn't find child process. (%d)", GetLastError());
    return false;
  }

  Log(L"Waiting on child process...");

  MSG msg;
  DWORD waitResult = WAIT_TIMEOUT;
  while ((waitResult = WaitForSingleObject(child, 10)) != WAIT_OBJECT_0) {
    if (PeekMessage(&msg, NULL, 0, 0, PM_REMOVE)) {
      TranslateMessage(&msg);
      DispatchMessage(&msg);
    }
  }

  Log(L"Exiting.");
  return true;
}

int wmain(int argc, WCHAR* argv[])
{
  CoInitialize(NULL);

  int idx;
  bool firefoxParam = false;
  for (idx = 1; idx < argc; idx++) {
    CString param = argv[idx];
    param.Trim();

    // Pickup the firefox path param and store it, we'll need this
    // when we create the tests.ini file.
    if (param == "-firefoxpath") {
      firefoxParam = true;
      continue;
    } else if (firefoxParam) {
      firefoxParam = false;
      sFirefoxPath = param;
      continue;
    }

    sAppParams.Append(argv[idx]);
    sAppParams.Append(L" ");
  }
  sAppParams.Trim();
  if (sFirefoxPath.GetLength()) {
    Log(L"firefoxpath: '%s'", sFirefoxPath);
  }
  AddConsoleIdToParams();
  Log(L"args: '%s'", sAppParams);
  Launch();

  CoUninitialize();
  return 0;
}
