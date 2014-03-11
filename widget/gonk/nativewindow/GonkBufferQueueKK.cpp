/*
 * Copyright (C) 2012 The Android Open Source Project
 * Copyright (C) 2013 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#define LOG_TAG "GonkBufferQueue"
#define ATRACE_TAG ATRACE_TAG_GRAPHICS
#define LOG_NDEBUG 0

#define GL_GLEXT_PROTOTYPES
#define EGL_EGLEXT_PROTOTYPES

#include <utils/Log.h>
#include <utils/Trace.h>
#include <utils/CallStack.h>
#include <cutils/compiler.h>
#include "mozilla/layers/ImageBridgeChild.h"
#include "GonkBufferQueueKK.h"

// Macros for including the GonkBufferQueue name in log messages
#define ST_LOGV(...) __android_log_print(ANDROID_LOG_VERBOSE, LOG_TAG, __VA_ARGS__)
#define ST_LOGD(...) __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, __VA_ARGS__)
#define ST_LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define ST_LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#define ST_LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

#define ATRACE_BUFFER_INDEX(index)

using namespace mozilla;
using namespace mozilla::gfx;
using namespace mozilla::layers;

namespace android {

// Get an ID that's unique within this process.
static int32_t createProcessUniqueId() {
    static volatile int32_t globalCounter = 0;
    return android_atomic_inc(&globalCounter);
}

static const char* scalingModeName(int scalingMode) {
    switch (scalingMode) {
        case NATIVE_WINDOW_SCALING_MODE_FREEZE: return "FREEZE";
        case NATIVE_WINDOW_SCALING_MODE_SCALE_TO_WINDOW: return "SCALE_TO_WINDOW";
        case NATIVE_WINDOW_SCALING_MODE_SCALE_CROP: return "SCALE_CROP";
        default: return "Unknown";
    }
}

GonkBufferQueue::GonkBufferQueue(bool allowSynchronousMode,
        const sp<IGraphicBufferAlloc>& allocator) :
    mDefaultWidth(1),
    mDefaultHeight(1),
    mMaxAcquiredBufferCount(1),
    mDefaultMaxBufferCount(2),
    mOverrideMaxBufferCount(0),
//    mSynchronousMode(true), // GonkBufferQueue always works in sync mode.
    mConsumerControlledByApp(false),
    mDequeueBufferCannotBlock(false),
    mUseAsyncBuffer(true),
    mConnectedApi(NO_CONNECTED_API),
    mAbandoned(false),
    mFrameCounter(0),
    mBufferHasBeenQueued(false),
    mDefaultBufferFormat(PIXEL_FORMAT_RGBA_8888),
    mConsumerUsageBits(0),
    mTransformHint(0),
    mGeneration(0)
{
    // Choose a name using the PID and a process-unique ID.
    mConsumerName = String8::format("unnamed-%d-%d", getpid(), createProcessUniqueId());

    ST_LOGV("GonkBufferQueue");
}

GonkBufferQueue::~GonkBufferQueue() {
    ST_LOGV("~GonkBufferQueue");
}

status_t GonkBufferQueue::setDefaultMaxBufferCountLocked(int count) {
    if (count < 2 || count > NUM_BUFFER_SLOTS)
        return BAD_VALUE;

    mDefaultMaxBufferCount = count;
    mDequeueCondition.broadcast();

    return NO_ERROR;
}

void GonkBufferQueue::setConsumerName(const String8& name) {
    Mutex::Autolock lock(mMutex);
    mConsumerName = name;
}

status_t GonkBufferQueue::setDefaultBufferFormat(uint32_t defaultFormat) {
    Mutex::Autolock lock(mMutex);
    mDefaultBufferFormat = defaultFormat;
    return NO_ERROR;
}

status_t GonkBufferQueue::setConsumerUsageBits(uint32_t usage) {
    Mutex::Autolock lock(mMutex);
    mConsumerUsageBits = usage;
    return NO_ERROR;
}

status_t GonkBufferQueue::setTransformHint(uint32_t hint) {
    ST_LOGV("setTransformHint: %02x", hint);
    Mutex::Autolock lock(mMutex);
    mTransformHint = hint;
    return NO_ERROR;
}

int GonkBufferQueue::getGeneration() {
    return mGeneration;
}

mozilla::layers::SurfaceDescriptor*
GonkBufferQueue::getSurfaceDescriptorFromBuffer(ANativeWindowBuffer* buffer)
{
    Mutex::Autolock _l(mMutex);
    if (buffer == NULL) {
        ST_LOGE("getSlotFromBufferLocked: encountered NULL buffer");
        return nullptr;
    }

    for (int i = 0; i < NUM_BUFFER_SLOTS; i++) {
        if (mSlots[i].mGraphicBuffer != NULL && mSlots[i].mGraphicBuffer->handle == buffer->handle) {
            return &mSlots[i].mSurfaceDescriptor;
        }
    }
    ST_LOGE("getSlotFromBufferLocked: unknown buffer: %p", buffer->handle);
    return nullptr;
}

status_t GonkBufferQueue::setBufferCount(int bufferCount) {
    ST_LOGV("setBufferCount: count=%d", bufferCount);

    sp<IConsumerListener> listener;
    nsAutoTArray<SurfaceDescriptor, NUM_BUFFER_SLOTS> freeList;
    {
        Mutex::Autolock lock(mMutex);

        if (mAbandoned) {
            ST_LOGE("setBufferCount: GonkBufferQueue has been abandoned!");
            return NO_INIT;
        }
        if (bufferCount > NUM_BUFFER_SLOTS) {
            ST_LOGE("setBufferCount: bufferCount too large (max %d)",
                    NUM_BUFFER_SLOTS);
            return BAD_VALUE;
        }

        // Error out if the user has dequeued buffers
        for (int i=0 ; i<NUM_BUFFER_SLOTS; i++) {
            if (mSlots[i].mBufferState == BufferSlot::DEQUEUED) {
                ST_LOGE("setBufferCount: client owns some buffers");
                return -EINVAL;
            }
        }

        if (bufferCount == 0) {
            mOverrideMaxBufferCount = 0;
            mDequeueCondition.broadcast();
            return NO_ERROR;
        }

        // fine to assume async to false before we're setting the buffer count
        const int minBufferSlots = getMinMaxBufferCountLocked(false);
        if (bufferCount < minBufferSlots) {
            ST_LOGE("setBufferCount: requested buffer count (%d) is less than "
                    "minimum (%d)", bufferCount, minBufferSlots);
            return BAD_VALUE;
        }

        // here we're guaranteed that the client doesn't have dequeued buffers
        // and will release all of its buffer references.  We don't clear the
        // queue, however, so currently queued buffers still get displayed.
        // XXX: Should this use drainQueueAndFreeBuffersLocked instead?
        freeAllBuffersLocked(freeList);
        mOverrideMaxBufferCount = bufferCount;
        mDequeueCondition.broadcast();
        listener = mConsumerListener;
    } // scope for lock
    releaseBufferFreeListUnlocked(freeList);

    if (listener != NULL) {
        listener->onBuffersReleased();
    }

    return NO_ERROR;
}

int GonkBufferQueue::query(int what, int* outValue)
{
    ATRACE_CALL();
    Mutex::Autolock lock(mMutex);

    if (mAbandoned) {
        ST_LOGE("query: GonkBufferQueue has been abandoned!");
        return NO_INIT;
    }

    int value;
    switch (what) {
    case NATIVE_WINDOW_WIDTH:
        value = mDefaultWidth;
        break;
    case NATIVE_WINDOW_HEIGHT:
        value = mDefaultHeight;
        break;
    case NATIVE_WINDOW_FORMAT:
        value = mDefaultBufferFormat;
        break;
    case NATIVE_WINDOW_MIN_UNDEQUEUED_BUFFERS:
        value = getMinUndequeuedBufferCount(false);
        break;
    case NATIVE_WINDOW_CONSUMER_RUNNING_BEHIND:
        value = (mQueue.size() >= 2);
        break;
    case NATIVE_WINDOW_CONSUMER_USAGE_BITS:
        value = mConsumerUsageBits;
        break;
    default:
        return BAD_VALUE;
    }
    outValue[0] = value;
    return NO_ERROR;
}

status_t GonkBufferQueue::requestBuffer(int slot, sp<GraphicBuffer>* buf) {
    ATRACE_CALL();
    ST_LOGV("requestBuffer: slot=%d", slot);
    Mutex::Autolock lock(mMutex);
    if (mAbandoned) {
        ST_LOGE("requestBuffer: GonkBufferQueue has been abandoned!");
        return NO_INIT;
    }
    if (slot < 0 || slot >= NUM_BUFFER_SLOTS) {
        ST_LOGE("requestBuffer: slot index out of range [0, %d]: %d",
                NUM_BUFFER_SLOTS, slot);
        return BAD_VALUE;
    } else if (mSlots[slot].mBufferState != BufferSlot::DEQUEUED) {
        ST_LOGE("requestBuffer: slot %d is not owned by the client (state=%d)",
                slot, mSlots[slot].mBufferState);
        return BAD_VALUE;
    }
    mSlots[slot].mRequestBufferCalled = true;
    *buf = mSlots[slot].mGraphicBuffer;
    return NO_ERROR;
}

status_t GonkBufferQueue::dequeueBuffer(int *outBuf, sp<Fence>* outFence, bool async,
            uint32_t w, uint32_t h, uint32_t format, uint32_t usage) {
    ATRACE_CALL();
    ST_LOGV("dequeueBuffer: w=%d h=%d fmt=%#x usage=%#x", w, h, format, usage);

    if ((w && !h) || (!w && h)) {
        ST_LOGE("dequeueBuffer: invalid size: w=%u, h=%u", w, h);
        return BAD_VALUE;
    }

    status_t returnFlags(OK);
    int buf = INVALID_BUFFER_SLOT;
    uint32_t generation;
    SurfaceDescriptor descOld;

    { // Scope for the lock
        Mutex::Autolock lock(mMutex);
        generation = mGeneration;

        if (format == 0) {
            format = mDefaultBufferFormat;
        }
        // turn on usage bits the consumer requested
        usage |= mConsumerUsageBits;

        int found = -1;
        bool tryAgain = true;
        while (tryAgain) {
            if (mAbandoned) {
                ST_LOGE("dequeueBuffer: GonkBufferQueue has been abandoned!");
                return NO_INIT;
            }

            const int maxBufferCount = getMaxBufferCountLocked(async);
            if (async && mOverrideMaxBufferCount) {
                // FIXME: some drivers are manually setting the buffer-count (which they
                // shouldn't), so we do this extra test here to handle that case.
                // This is TEMPORARY, until we get this fixed.
                if (mOverrideMaxBufferCount < maxBufferCount) {
                    ST_LOGE("dequeueBuffer: async mode is invalid with buffercount override");
                    return BAD_VALUE;
                }
            }

            // Free up any buffers that are in slots beyond the max buffer
            // count.
            //for (int i = maxBufferCount; i < NUM_BUFFER_SLOTS; i++) {
            //    assert(mSlots[i].mBufferState == BufferSlot::FREE);
            //    if (mSlots[i].mGraphicBuffer != NULL) {
            //        freeBufferLocked(i);
            //        returnFlags |= IGraphicBufferProducer::RELEASE_ALL_BUFFERS;
            //    }
            //}

            // look for a free buffer to give to the client
            found = INVALID_BUFFER_SLOT;
            int dequeuedCount = 0;
            int acquiredCount = 0;
            for (int i = 0; i < maxBufferCount; i++) {
                const int state = mSlots[i].mBufferState;
                switch (state) {
                    case BufferSlot::DEQUEUED:
                    dequeuedCount++;
                        break;
                    case BufferSlot::ACQUIRED:
                        acquiredCount++;
                        break;
                    case BufferSlot::FREE:
                    /* We return the oldest of the free buffers to avoid
                     * stalling the producer if possible.  This is because
                     * the consumer may still have pending reads of the
                     * buffers in flight.
                     */
                    if ((found < 0) ||
                            mSlots[i].mFrameNumber < mSlots[found].mFrameNumber) {
                        found = i;
                    }
                        break;
                }
            }

            // clients are not allowed to dequeue more than one buffer
            // if they didn't set a buffer count.
            if (!mOverrideMaxBufferCount && dequeuedCount) {
                ST_LOGE("dequeueBuffer: can't dequeue multiple buffers without "
                        "setting the buffer count");
                return -EINVAL;
            }

            // See whether a buffer has been queued since the last
            // setBufferCount so we know whether to perform the min undequeued
            // buffers check below.
            if (mBufferHasBeenQueued) {
                // make sure the client is not trying to dequeue more buffers
                // than allowed.
                const int newUndequeuedCount = maxBufferCount - (dequeuedCount+1);
                const int minUndequeuedCount = getMinUndequeuedBufferCount(async);
                if (newUndequeuedCount < minUndequeuedCount) {
                    ST_LOGE("dequeueBuffer: min undequeued buffer count (%d) "
                            "exceeded (dequeued=%d undequeudCount=%d)",
                            minUndequeuedCount, dequeuedCount,
                            newUndequeuedCount);
                    return -EBUSY;
                }
            }

            // If no buffer is found, wait for a buffer to be released or for
            // the max buffer count to change.
            tryAgain = found == INVALID_BUFFER_SLOT;
            if (tryAgain) {
                // return an error if we're in "cannot block" mode (producer and consumer
                // are controlled by the application) -- however, the consumer is allowed
                // to acquire briefly an extra buffer (which could cause us to have to wait here)
                // and that's okay because we know the wait will be brief (it happens
                // if we dequeue a buffer while the consumer has acquired one but not released
                // the old one yet -- for e.g.: see GLConsumer::updateTexImage()).
                if (mDequeueBufferCannotBlock && (acquiredCount <= mMaxAcquiredBufferCount)) {
                    ST_LOGE("dequeueBuffer: would block! returning an error instead.");
                    return WOULD_BLOCK;
                }
                mDequeueCondition.wait(mMutex);
            }
        }


        if (found == INVALID_BUFFER_SLOT) {
            // This should not happen.
            ST_LOGE("dequeueBuffer: no available buffer slots");
            return -EBUSY;
        }

        buf = found;
        *outBuf = found;

        const bool useDefaultSize = !w && !h;
        if (useDefaultSize) {
            // use the default size
            w = mDefaultWidth;
            h = mDefaultHeight;
        }

        mSlots[buf].mBufferState = BufferSlot::DEQUEUED;

        const sp<GraphicBuffer>& buffer(mSlots[buf].mGraphicBuffer);
        if ((buffer == NULL) ||
            (uint32_t(buffer->width)  != w) ||
            (uint32_t(buffer->height) != h) ||
            (uint32_t(buffer->format) != format) ||
            ((uint32_t(buffer->usage) & usage) != usage))
        {
            mSlots[buf].mAcquireCalled = false;
            mSlots[buf].mGraphicBuffer = NULL;
            mSlots[buf].mRequestBufferCalled = false;
            mSlots[buf].mFence = Fence::NO_FENCE;
            descOld = mSlots[buf].mSurfaceDescriptor;
            mSlots[buf].mSurfaceDescriptor = SurfaceDescriptor();

            returnFlags |= IGraphicBufferProducer::BUFFER_NEEDS_REALLOCATION;
        }


        if (CC_UNLIKELY(mSlots[buf].mFence == NULL)) {
            ST_LOGE("dequeueBuffer: about to return a NULL fence from mSlot. "
                    "buf=%d, w=%d, h=%d, format=%d",
                    buf, buffer->width, buffer->height, buffer->format);
        }
        *outFence = mSlots[buf].mFence;
        mSlots[buf].mFence = Fence::NO_FENCE;
    }  // end lock scope

    SurfaceDescriptor desc;
    ImageBridgeChild* ibc;
    sp<GraphicBuffer> graphicBuffer;
    if (returnFlags & IGraphicBufferProducer::BUFFER_NEEDS_REALLOCATION) {
        usage |= GraphicBuffer::USAGE_HW_TEXTURE;
        status_t error;
        ibc = ImageBridgeChild::GetSingleton();
        ST_LOGD("dequeueBuffer: about to alloc surface descriptor");
        ibc->AllocSurfaceDescriptorGralloc(IntSize(w, h),
                                           format,
                                           usage,
                                           &desc);
        // We can only use a gralloc buffer here.  If we didn't get
        // one back, something went wrong.
        ST_LOGD("dequeueBuffer: got surface descriptor");
        if (SurfaceDescriptor::TSurfaceDescriptorGralloc != desc.type()) {
            MOZ_ASSERT(SurfaceDescriptor::T__None == desc.type());
            ST_LOGE("dequeueBuffer: failed to alloc gralloc buffer");
            return -ENOMEM;
        }
        graphicBuffer = GrallocBufferActor::GetFrom(desc.get_SurfaceDescriptorGralloc());
        error = graphicBuffer->initCheck();
        if (error != NO_ERROR) {
            ST_LOGE("dequeueBuffer: createGraphicBuffer failed with error %d", error);
            return error;
        }

        bool tooOld = false;
        { // Scope for the lock
            Mutex::Autolock lock(mMutex);

            if (mAbandoned) {
                ST_LOGE("dequeueBuffer: SurfaceTexture has been abandoned!");
                return NO_INIT;
            }

            if (generation == mGeneration) {
                mSlots[buf].mGraphicBuffer = graphicBuffer;
                mSlots[buf].mSurfaceDescriptor = desc;
                mSlots[buf].mSurfaceDescriptor.get_SurfaceDescriptorGralloc().external() = true;
                ST_LOGD("dequeueBuffer: returning slot=%d buf=%p ", buf,
                        mSlots[buf].mGraphicBuffer->handle);
            } else {
                tooOld = true;
            }
        }

        if (IsSurfaceDescriptorValid(descOld)) {
            ibc->DeallocSurfaceDescriptorGralloc(descOld);
        }

        if (tooOld) {
            ibc->DeallocSurfaceDescriptorGralloc(desc);
        }
    }

    ST_LOGV("dequeueBuffer: returning slot=%d/%llu buf=%p flags=%#x", *outBuf,
            mSlots[*outBuf].mFrameNumber,
            mSlots[*outBuf].mGraphicBuffer->handle, returnFlags);

    return returnFlags;
}

status_t GonkBufferQueue::queueBuffer(int buf,
        const QueueBufferInput& input, QueueBufferOutput* output) {
    ATRACE_CALL();

    Rect crop;
    uint32_t transform;
    int scalingMode;
    int64_t timestamp;
    bool isAutoTimestamp;
    bool async;
    sp<Fence> fence;

    input.deflate(&timestamp, &isAutoTimestamp, &crop, &scalingMode, &transform,
             &async, &fence);

    if (fence == NULL) {
        ST_LOGE("queueBuffer: fence is NULL");
        return BAD_VALUE;
    }

    ST_LOGV("queueBuffer: slot=%d time=%#llx crop=[%d,%d,%d,%d] tr=%#x "
            "scale=%s",
            buf, timestamp, crop.left, crop.top, crop.right, crop.bottom,
            transform, scalingModeName(scalingMode));

    switch (scalingMode) {
        case NATIVE_WINDOW_SCALING_MODE_FREEZE:
        case NATIVE_WINDOW_SCALING_MODE_SCALE_TO_WINDOW:
        case NATIVE_WINDOW_SCALING_MODE_SCALE_CROP:
        case NATIVE_WINDOW_SCALING_MODE_NO_SCALE_CROP:
            break;
        default:
            ST_LOGE("unknown scaling mode: %d", scalingMode);
            return -EINVAL;
    }

    sp<IConsumerListener> listener;

    { // scope for the lock
        Mutex::Autolock lock(mMutex);

        if (mAbandoned) {
            ST_LOGE("queueBuffer: GonkBufferQueue has been abandoned!");
            return NO_INIT;
        }

        const int maxBufferCount = getMaxBufferCountLocked(async);
        if (async && mOverrideMaxBufferCount) {
            // FIXME: some drivers are manually setting the buffer-count (which they
            // shouldn't), so we do this extra test here to handle that case.
            // This is TEMPORARY, until we get this fixed.
            if (mOverrideMaxBufferCount < maxBufferCount) {
                ST_LOGE("queueBuffer: async mode is invalid with buffercount override");
                return BAD_VALUE;
            }
        }
        if (buf < 0 || buf >= maxBufferCount) {
            ST_LOGE("queueBuffer: slot index out of range [0, %d]: %d",
                    maxBufferCount, buf);
            return -EINVAL;
        } else if (mSlots[buf].mBufferState != BufferSlot::DEQUEUED) {
            ST_LOGE("queueBuffer: slot %d is not owned by the client "
                    "(state=%d)", buf, mSlots[buf].mBufferState);
            return -EINVAL;
        } else if (!mSlots[buf].mRequestBufferCalled) {
            ST_LOGE("queueBuffer: slot %d was enqueued without requesting a "
                    "buffer", buf);
            return -EINVAL;
        }

        ST_LOGV("queueBuffer: slot=%d/%llu time=%#llx crop=[%d,%d,%d,%d] "
                "tr=%#x scale=%s",
                buf, mFrameCounter + 1, timestamp,
                crop.left, crop.top, crop.right, crop.bottom,
                transform, scalingModeName(scalingMode));

        const sp<GraphicBuffer>& graphicBuffer(mSlots[buf].mGraphicBuffer);
        Rect bufferRect(graphicBuffer->getWidth(), graphicBuffer->getHeight());
        Rect croppedCrop;
        crop.intersect(bufferRect, &croppedCrop);
        if (croppedCrop != crop) {
            ST_LOGE("queueBuffer: crop rect is not contained within the "
                    "buffer in slot %d", buf);
            return -EINVAL;
        }

        mSlots[buf].mFence = fence;
        mSlots[buf].mBufferState = BufferSlot::QUEUED;
        mFrameCounter++;
        mSlots[buf].mFrameNumber = mFrameCounter;

        BufferItem item;
        item.mAcquireCalled = mSlots[buf].mAcquireCalled;
        item.mGraphicBuffer = mSlots[buf].mGraphicBuffer;
        item.mCrop = crop;
        item.mTransform = transform & ~NATIVE_WINDOW_TRANSFORM_INVERSE_DISPLAY;
        item.mTransformToDisplayInverse = bool(transform & NATIVE_WINDOW_TRANSFORM_INVERSE_DISPLAY);
        item.mScalingMode = scalingMode;
        item.mTimestamp = timestamp;
        item.mIsAutoTimestamp = isAutoTimestamp;
        item.mFrameNumber = mFrameCounter;
        item.mBuf = buf;
        item.mFence = fence;
        item.mIsDroppable = mDequeueBufferCannotBlock || async;

        if (mQueue.empty()) {
            // when the queue is empty, we can ignore "mDequeueBufferCannotBlock", and
            // simply queue this buffer.
            mQueue.push_back(item);
            listener = mConsumerListener;
        } else {
            // when the queue is not empty, we need to look at the front buffer
            // state and see if we need to replace it.
            Fifo::iterator front(mQueue.begin());
            if (front->mIsDroppable) {
                // buffer slot currently queued is marked free if still tracked
                if (stillTracking(front)) {
                    mSlots[front->mBuf].mBufferState = BufferSlot::FREE;
                    // reset the frame number of the freed buffer so that it is the first in
                    // line to be dequeued again.
                    mSlots[front->mBuf].mFrameNumber = 0;
                }
                // and we record the new buffer in the queued list
                *front = item;
            } else {
                mQueue.push_back(item);
                listener = mConsumerListener;
            }
        }

        mBufferHasBeenQueued = true;
        mDequeueCondition.broadcast();

        output->inflate(mDefaultWidth, mDefaultHeight, mTransformHint,
                mQueue.size());

    } // scope for the lock

    // call back without lock held
    if (listener != 0) {
        listener->onFrameAvailable();
    }
    return NO_ERROR;
}

void GonkBufferQueue::cancelBuffer(int buf, const sp<Fence>& fence) {
    ATRACE_CALL();
    ST_LOGV("cancelBuffer: slot=%d", buf);
    Mutex::Autolock lock(mMutex);

    if (mAbandoned) {
        ST_LOGW("cancelBuffer: GonkBufferQueue has been abandoned!");
        return;
    }

    if (buf < 0 || buf >= NUM_BUFFER_SLOTS) {
        ST_LOGE("cancelBuffer: slot index out of range [0, %d]: %d",
                NUM_BUFFER_SLOTS, buf);
        return;
    } else if (mSlots[buf].mBufferState != BufferSlot::DEQUEUED) {
        ST_LOGE("cancelBuffer: slot %d is not owned by the client (state=%d)",
                buf, mSlots[buf].mBufferState);
        return;
    } else if (fence == NULL) {
        ST_LOGE("cancelBuffer: fence is NULL");
        return;
    }
    mSlots[buf].mBufferState = BufferSlot::FREE;
    mSlots[buf].mFrameNumber = 0;
    mSlots[buf].mFence = fence;
    mDequeueCondition.broadcast();
}


status_t GonkBufferQueue::connect(const sp<IBinder>& token,
        int api, bool producerControlledByApp, QueueBufferOutput* output) {
    ATRACE_CALL();
    ST_LOGV("connect: api=%d producerControlledByApp=%s", api,
            producerControlledByApp ? "true" : "false");
    Mutex::Autolock lock(mMutex);

retry:
    if (mAbandoned) {
        ST_LOGE("connect: GonkBufferQueue has been abandoned!");
        return NO_INIT;
    }

    if (mConsumerListener == NULL) {
        ST_LOGE("connect: GonkBufferQueue has no consumer!");
        return NO_INIT;
    }

    if (mConnectedApi != NO_CONNECTED_API) {
        ST_LOGE("connect: already connected (cur=%d, req=%d)",
                mConnectedApi, api);
        return -EINVAL;
    }

    // If we disconnect and reconnect quickly, we can be in a state where our slots are
    // empty but we have many buffers in the queue.  This can cause us to run out of
    // memory if we outrun the consumer.  Wait here if it looks like we have too many
    // buffers queued up.
    int maxBufferCount = getMaxBufferCountLocked(false);    // worst-case, i.e. largest value
    if (mQueue.size() > (size_t) maxBufferCount) {
        // TODO: make this bound tighter?
        ST_LOGV("queue size is %d, waiting", mQueue.size());
        mDequeueCondition.wait(mMutex);
        goto retry;
    }

    int err = NO_ERROR;
    switch (api) {
        case NATIVE_WINDOW_API_EGL:
        case NATIVE_WINDOW_API_CPU:
        case NATIVE_WINDOW_API_MEDIA:
        case NATIVE_WINDOW_API_CAMERA:
            mConnectedApi = api;
            output->inflate(mDefaultWidth, mDefaultHeight, mTransformHint, mQueue.size());

            // set-up a death notification so that we can disconnect
            // automatically when/if the remote producer dies.
            if (token != NULL && token->remoteBinder() != NULL) {
                status_t err = token->linkToDeath(static_cast<IBinder::DeathRecipient*>(this));
                if (err == NO_ERROR) {
                    mConnectedProducerToken = token;
                } else {
                    ALOGE("linkToDeath failed: %s (%d)", strerror(-err), err);
                }
            }
            break;
        default:
            err = -EINVAL;
            break;
    }

    mBufferHasBeenQueued = false;
    mDequeueBufferCannotBlock = mConsumerControlledByApp && producerControlledByApp;

    return err;
}

void GonkBufferQueue::binderDied(const wp<IBinder>& who) {
    // If we're here, it means that a producer we were connected to died.
    // We're GUARANTEED that we still are connected to it because it has no other way
    // to get disconnected -- or -- we wouldn't be here because we're removing this
    // callback upon disconnect. Therefore, it's okay to read mConnectedApi without
    // synchronization here.
    int api = mConnectedApi;
    this->disconnect(api);
}

status_t GonkBufferQueue::disconnect(int api) {
    ATRACE_CALL();
    ST_LOGV("disconnect: api=%d", api);

    int err = NO_ERROR;
    sp<IConsumerListener> listener;
    nsAutoTArray<SurfaceDescriptor, NUM_BUFFER_SLOTS> freeList;

    { // Scope for the lock
        Mutex::Autolock lock(mMutex);

        if (mAbandoned) {
            // it is not really an error to disconnect after the surface
            // has been abandoned, it should just be a no-op.
            return NO_ERROR;
        }

        switch (api) {
            case NATIVE_WINDOW_API_EGL:
            case NATIVE_WINDOW_API_CPU:
            case NATIVE_WINDOW_API_MEDIA:
            case NATIVE_WINDOW_API_CAMERA:
                if (mConnectedApi == api) {
                    freeAllBuffersLocked(freeList);
                    mConnectedApi = NO_CONNECTED_API;
                    mDequeueCondition.broadcast();
                    listener = mConsumerListener;
                } else {
                    ST_LOGE("disconnect: connected to another api (cur=%d, req=%d)",
                            mConnectedApi, api);
                    err = -EINVAL;
                }
                break;
            default:
                ST_LOGE("disconnect: unknown API %d", api);
                err = -EINVAL;
                break;
        }
    }
    releaseBufferFreeListUnlocked(freeList);

    if (listener != NULL) {
        listener->onBuffersReleased();
    }

    return err;
}

void GonkBufferQueue::dump(String8& result, const char* prefix) const {
    Mutex::Autolock _l(mMutex);

    String8 fifo;
    int fifoSize = 0;
    Fifo::const_iterator i(mQueue.begin());
    while (i != mQueue.end()) {
        fifo.appendFormat("%02d:%p crop=[%d,%d,%d,%d], "
                "xform=0x%02x, time=%#llx, scale=%s\n",
                i->mBuf, i->mGraphicBuffer.get(),
                i->mCrop.left, i->mCrop.top, i->mCrop.right,
                i->mCrop.bottom, i->mTransform, i->mTimestamp,
                scalingModeName(i->mScalingMode)
                );
        i++;
        fifoSize++;
    }


    result.appendFormat(
            "%s-BufferQueue mMaxAcquiredBufferCount=%d, mDequeueBufferCannotBlock=%d, default-size=[%dx%d], "
            "default-format=%d, transform-hint=%02x, FIFO(%d)={%s}\n",
            prefix, mMaxAcquiredBufferCount, mDequeueBufferCannotBlock, mDefaultWidth,
            mDefaultHeight, mDefaultBufferFormat, mTransformHint,
            fifoSize, fifo.string());

    struct {
        const char * operator()(int state) const {
            switch (state) {
                case BufferSlot::DEQUEUED: return "DEQUEUED";
                case BufferSlot::QUEUED: return "QUEUED";
                case BufferSlot::FREE: return "FREE";
                case BufferSlot::ACQUIRED: return "ACQUIRED";
                default: return "Unknown";
            }
        }
    } stateName;

    // just trim the free buffers to not spam the dump
    int maxBufferCount = 0;
    for (int i=NUM_BUFFER_SLOTS-1 ; i>=0 ; i--) {
        const BufferSlot& slot(mSlots[i]);
        if ((slot.mBufferState != BufferSlot::FREE) || (slot.mGraphicBuffer != NULL)) {
            maxBufferCount = i+1;
            break;
        }
    }

    for (int i=0 ; i<maxBufferCount ; i++) {
        const BufferSlot& slot(mSlots[i]);
        const sp<GraphicBuffer>& buf(slot.mGraphicBuffer);
        result.appendFormat(
            "%s%s[%02d:%p] state=%-8s",
                prefix, (slot.mBufferState == BufferSlot::ACQUIRED)?">":" ", i, buf.get(),
                stateName(slot.mBufferState)
        );

        if (buf != NULL) {
            result.appendFormat(
                    ", %p [%4ux%4u:%4u,%3X]",
                    buf->handle, buf->width, buf->height, buf->stride,
                    buf->format);
        }
        result.append("\n");
    }
}

void GonkBufferQueue::releaseBufferFreeListUnlocked(nsTArray<SurfaceDescriptor>& freeList)
{
    // This function MUST ONLY be called with mMutex unlocked; else there
    // is a risk of deadlock with the ImageBridge thread.

    ST_LOGD("releaseBufferFreeListUnlocked: E");
    ImageBridgeChild *ibc = ImageBridgeChild::GetSingleton();

    for (uint32_t i = 0; i < freeList.Length(); ++i) {
        ibc->DeallocSurfaceDescriptorGralloc(freeList[i]);
    }

    freeList.Clear();
    ST_LOGD("releaseBufferFreeListUnlocked: X");
}

void GonkBufferQueue::freeAllBuffersLocked(nsTArray<SurfaceDescriptor>& freeList)
{
    ALOGW_IF(!mQueue.isEmpty(),
            "freeAllBuffersLocked called but mQueue is not empty");
    ++mGeneration;
    mQueue.clear();
    mBufferHasBeenQueued = false;
    for (int i = 0; i < NUM_BUFFER_SLOTS; i++) {
        if (mSlots[i].mGraphicBuffer.get() && mSlots[i].mBufferState != BufferSlot::ACQUIRED) {
            SurfaceDescriptor* desc = freeList.AppendElement();
            *desc = mSlots[i].mSurfaceDescriptor;
        }
        mSlots[i].mGraphicBuffer = 0;
        mSlots[i].mSurfaceDescriptor = SurfaceDescriptor();
        if (mSlots[i].mBufferState == BufferSlot::ACQUIRED) {
            mSlots[i].mNeedsCleanupOnRelease = true;
        }
        mSlots[i].mBufferState = BufferSlot::FREE;
        mSlots[i].mFrameNumber = 0;
        mSlots[i].mAcquireCalled = false;
        // destroy fence as GonkBufferQueue now takes ownership
        mSlots[i].mFence = Fence::NO_FENCE;
    }
}

status_t GonkBufferQueue::acquireBuffer(BufferItem *buffer, nsecs_t expectedPresent) {
    ATRACE_CALL();
    Mutex::Autolock _l(mMutex);

    // Check that the consumer doesn't currently have the maximum number of
    // buffers acquired.  We allow the max buffer count to be exceeded by one
    // buffer, so that the consumer can successfully set up the newly acquired
    // buffer before releasing the old one.
    int numAcquiredBuffers = 0;
    for (int i = 0; i < NUM_BUFFER_SLOTS; i++) {
        if (mSlots[i].mBufferState == BufferSlot::ACQUIRED) {
            numAcquiredBuffers++;
        }
    }
    if (numAcquiredBuffers >= mMaxAcquiredBufferCount+1) {
        ST_LOGE("acquireBuffer: max acquired buffer count reached: %d (max=%d)",
                numAcquiredBuffers, mMaxAcquiredBufferCount);
        return INVALID_OPERATION;
    }

    // check if queue is empty
    // In asynchronous mode the list is guaranteed to be one buffer
    // deep, while in synchronous mode we use the oldest buffer.
    if (mQueue.empty()) {
        return NO_BUFFER_AVAILABLE;
    }

    Fifo::iterator front(mQueue.begin());

    // If expectedPresent is specified, we may not want to return a buffer yet.
    // If it's specified and there's more than one buffer queued, we may
    // want to drop a buffer.
    if (expectedPresent != 0) {
        const int MAX_REASONABLE_NSEC = 1000000000ULL;  // 1 second

        // The "expectedPresent" argument indicates when the buffer is expected
        // to be presented on-screen.  If the buffer's desired-present time
        // is earlier (less) than expectedPresent, meaning it'll be displayed
        // on time or possibly late if we show it ASAP, we acquire and return
        // it.  If we don't want to display it until after the expectedPresent
        // time, we return PRESENT_LATER without acquiring it.
        //
        // To be safe, we don't defer acquisition if expectedPresent is
        // more than one second in the future beyond the desired present time
        // (i.e. we'd be holding the buffer for a long time).
        //
        // NOTE: code assumes monotonic time values from the system clock are
        // positive.

        // Start by checking to see if we can drop frames.  We skip this check
        // if the timestamps are being auto-generated by Surface -- if the
        // app isn't generating timestamps explicitly, they probably don't
        // want frames to be discarded based on them.
        while (mQueue.size() > 1 && !mQueue[0].mIsAutoTimestamp) {
            // If entry[1] is timely, drop entry[0] (and repeat).  We apply
            // an additional criteria here: we only drop the earlier buffer if
            // our desiredPresent falls within +/- 1 second of the expected
            // present.  Otherwise, bogus desiredPresent times (e.g. 0 or
            // a small relative timestamp), which normally mean "ignore the
            // timestamp and acquire immediately", would cause us to drop
            // frames.
            //
            // We may want to add an additional criteria: don't drop the
            // earlier buffer if entry[1]'s fence hasn't signaled yet.
            //
            // (Vector front is [0], back is [size()-1])
            const BufferItem& bi(mQueue[1]);
            nsecs_t desiredPresent = bi.mTimestamp;
            if (desiredPresent < expectedPresent - MAX_REASONABLE_NSEC ||
                    desiredPresent > expectedPresent) {
                // This buffer is set to display in the near future, or
                // desiredPresent is garbage.  Either way we don't want to
                // drop the previous buffer just to get this on screen sooner.
                ST_LOGV("pts nodrop: des=%lld expect=%lld (%lld) now=%lld",
                        desiredPresent, expectedPresent, desiredPresent - expectedPresent,
                        systemTime(CLOCK_MONOTONIC));
                break;
            }
            ST_LOGV("pts drop: queue1des=%lld expect=%lld size=%d",
                    desiredPresent, expectedPresent, mQueue.size());
            if (stillTracking(front)) {
                // front buffer is still in mSlots, so mark the slot as free
                mSlots[front->mBuf].mBufferState = BufferSlot::FREE;
            }
            mQueue.erase(front);
            front = mQueue.begin();
        }

        // See if the front buffer is due.
        nsecs_t desiredPresent = front->mTimestamp;
        if (desiredPresent > expectedPresent &&
                desiredPresent < expectedPresent + MAX_REASONABLE_NSEC) {
            ST_LOGV("pts defer: des=%lld expect=%lld (%lld) now=%lld",
                    desiredPresent, expectedPresent, desiredPresent - expectedPresent,
                    systemTime(CLOCK_MONOTONIC));
            return PRESENT_LATER;
        }

        ST_LOGV("pts accept: des=%lld expect=%lld (%lld) now=%lld",
                desiredPresent, expectedPresent, desiredPresent - expectedPresent,
                systemTime(CLOCK_MONOTONIC));
    }

    int buf = front->mBuf;
    buffer->mGraphicBuffer = mSlots[buf].mGraphicBuffer;
    buffer->mSurfaceDescriptor = mSlots[buf].mSurfaceDescriptor;
    buffer->mFrameNumber = mSlots[buf].mFrameNumber;
    buffer->mBuf = buf;
    buffer->mFence = mSlots[buf].mFence;
    ATRACE_BUFFER_INDEX(buf);

    ST_LOGV("acquireBuffer: acquiring { slot=%d/%llu, buffer=%p }",
            front->mBuf, front->mFrameNumber,
            front->mGraphicBuffer->handle);
    // if front buffer still being tracked update slot state
    if (stillTracking(front)) {
        mSlots[buf].mAcquireCalled = true;
        mSlots[buf].mNeedsCleanupOnRelease = false;
        mSlots[buf].mBufferState = BufferSlot::ACQUIRED;
        mSlots[buf].mFence = Fence::NO_FENCE;
    }

    // If the buffer has previously been acquired by the consumer, set
    // mGraphicBuffer to NULL to avoid unnecessarily remapping this
    // buffer on the consumer side.
    //if (buffer->mAcquireCalled) {
    //    buffer->mGraphicBuffer = NULL;
    //}

    mQueue.erase(front);
    mDequeueCondition.broadcast();

    return NO_ERROR;
}

status_t GonkBufferQueue::releaseBuffer(int buf, uint64_t frameNumber, const sp<Fence>& fence) {
    ATRACE_CALL();

    if (buf == INVALID_BUFFER_SLOT || fence == NULL) {
        return BAD_VALUE;
    }

    Mutex::Autolock _l(mMutex);

    // If the frame number has changed because buffer has been reallocated,
    // we can ignore this releaseBuffer for the old buffer.
    //if (frameNumber != mSlots[buf].mFrameNumber) {
    //    return STALE_BUFFER_SLOT;
    //}


    // Internal state consistency checks:
    // Make sure this buffers hasn't been queued while we were owning it (acquired)
    Fifo::iterator front(mQueue.begin());
    Fifo::const_iterator const end(mQueue.end());
    while (front != end) {
        if (front->mBuf == buf) {
            LOG_ALWAYS_FATAL("[%s] received new buffer(#%lld) on slot #%d that has not yet been "
                    "acquired", mConsumerName.string(), frameNumber, buf);
            break; // never reached
        }
        front++;
    }

    // The buffer can now only be released if its in the acquired state
    if (mSlots[buf].mBufferState == BufferSlot::ACQUIRED) {
        mSlots[buf].mFence = fence;
        mSlots[buf].mBufferState = BufferSlot::FREE;
    } else if (mSlots[buf].mNeedsCleanupOnRelease) {
        ST_LOGV("releasing a stale buf %d its state was %d", buf, mSlots[buf].mBufferState);
        mSlots[buf].mNeedsCleanupOnRelease = false;
        return STALE_BUFFER_SLOT;
    } else {
        ST_LOGE("attempted to release buf %d but its state was %d", buf, mSlots[buf].mBufferState);
        return -EINVAL;
    }

    mDequeueCondition.broadcast();
    return NO_ERROR;
}

status_t GonkBufferQueue::consumerConnect(const sp<IConsumerListener>& consumerListener,
        bool controlledByApp) {
    ST_LOGV("consumerConnect controlledByApp=%s",
            controlledByApp ? "true" : "false");
    Mutex::Autolock lock(mMutex);

    if (mAbandoned) {
        ST_LOGE("consumerConnect: GonkBufferQueue has been abandoned!");
        return NO_INIT;
    }
    if (consumerListener == NULL) {
        ST_LOGE("consumerConnect: consumerListener may not be NULL");
        return BAD_VALUE;
    }

    mConsumerListener = consumerListener;
    mConsumerControlledByApp = controlledByApp;

    return NO_ERROR;
}

status_t GonkBufferQueue::consumerDisconnect() {
    ST_LOGV("consumerDisconnect");
    nsAutoTArray<SurfaceDescriptor, NUM_BUFFER_SLOTS> freeList;
    {
        Mutex::Autolock lock(mMutex);

        if (mConsumerListener == NULL) {
            ST_LOGE("consumerDisconnect: No consumer is connected!");
            return -EINVAL;
        }

        mAbandoned = true;
        mConsumerListener = NULL;
        mQueue.clear();
        freeAllBuffersLocked(freeList);
    }
    releaseBufferFreeListUnlocked(freeList);
    mDequeueCondition.broadcast();

    return NO_ERROR;
}

status_t GonkBufferQueue::getReleasedBuffers(uint32_t* slotMask) {
    ST_LOGV("getReleasedBuffers");
    Mutex::Autolock lock(mMutex);

    if (mAbandoned) {
        ST_LOGE("getReleasedBuffers: GonkBufferQueue has been abandoned!");
        return NO_INIT;
    }

    uint32_t mask = 0;
    for (int i = 0; i < NUM_BUFFER_SLOTS; i++) {
        if (!mSlots[i].mAcquireCalled) {
            mask |= 1 << i;
        }
    }

    // Remove buffers in flight (on the queue) from the mask where acquire has
    // been called, as the consumer will not receive the buffer address, so
    // it should not free these slots.
    Fifo::iterator front(mQueue.begin());
    while (front != mQueue.end()) {
        if (front->mAcquireCalled)
            mask &= ~(1 << front->mBuf);
        front++;
    }

    *slotMask = mask;

    ST_LOGV("getReleasedBuffers: returning mask %#x", mask);
    return NO_ERROR;
}

status_t GonkBufferQueue::setDefaultBufferSize(uint32_t w, uint32_t h) {
    ST_LOGV("setDefaultBufferSize: w=%d, h=%d", w, h);
    if (!w || !h) {
        ST_LOGE("setDefaultBufferSize: dimensions cannot be 0 (w=%d, h=%d)",
                w, h);
        return BAD_VALUE;
    }

    Mutex::Autolock lock(mMutex);
    mDefaultWidth = w;
    mDefaultHeight = h;
    return NO_ERROR;
}

status_t GonkBufferQueue::setDefaultMaxBufferCount(int bufferCount) {
    ATRACE_CALL();
    Mutex::Autolock lock(mMutex);
    return setDefaultMaxBufferCountLocked(bufferCount);
}

status_t GonkBufferQueue::disableAsyncBuffer() {
    ATRACE_CALL();
    Mutex::Autolock lock(mMutex);
    if (mConsumerListener != NULL) {
        ST_LOGE("disableAsyncBuffer: consumer already connected!");
        return INVALID_OPERATION;
    }
    mUseAsyncBuffer = false;
    return NO_ERROR;
}

status_t GonkBufferQueue::setMaxAcquiredBufferCount(int maxAcquiredBuffers) {
    ATRACE_CALL();
    Mutex::Autolock lock(mMutex);
    if (maxAcquiredBuffers < 1 || maxAcquiredBuffers > MAX_MAX_ACQUIRED_BUFFERS) {
        ST_LOGE("setMaxAcquiredBufferCount: invalid count specified: %d",
                maxAcquiredBuffers);
        return BAD_VALUE;
    }
    if (mConnectedApi != NO_CONNECTED_API) {
        return INVALID_OPERATION;
    }
    mMaxAcquiredBufferCount = maxAcquiredBuffers;
    return NO_ERROR;
}

int GonkBufferQueue::getMinUndequeuedBufferCount(bool async) const {
    // if dequeueBuffer is allowed to error out, we don't have to
    // add an extra buffer.
    if (!mUseAsyncBuffer)
        return mMaxAcquiredBufferCount;

    // we're in async mode, or we want to prevent the app to
    // deadlock itself, we throw-in an extra buffer to guarantee it.
    if (mDequeueBufferCannotBlock || async)
        return mMaxAcquiredBufferCount + 1;

    return mMaxAcquiredBufferCount;
}

int GonkBufferQueue::getMinMaxBufferCountLocked(bool async) const {
    return getMinUndequeuedBufferCount(async) + 1;
}

int GonkBufferQueue::getMaxBufferCountLocked(bool async) const {
    int minMaxBufferCount = getMinMaxBufferCountLocked(async);

    int maxBufferCount = mDefaultMaxBufferCount;
    if (maxBufferCount < minMaxBufferCount) {
        maxBufferCount = minMaxBufferCount;
    }
    if (mOverrideMaxBufferCount != 0) {
        assert(mOverrideMaxBufferCount >= minMaxBufferCount);
        maxBufferCount = mOverrideMaxBufferCount;
    }

    // Any buffers that are dequeued by the producer or sitting in the queue
    // waiting to be consumed need to have their slots preserved.  Such
    // buffers will temporarily keep the max buffer count up until the slots
    // no longer need to be preserved.
    for (int i = maxBufferCount; i < NUM_BUFFER_SLOTS; i++) {
        BufferSlot::BufferState state = mSlots[i].mBufferState;
        if (state == BufferSlot::QUEUED || state == BufferSlot::DEQUEUED) {
            maxBufferCount = i + 1;
        }
    }

    return maxBufferCount;
}

bool GonkBufferQueue::stillTracking(const BufferItem *item) const {
    const BufferSlot &slot = mSlots[item->mBuf];

    ST_LOGV("stillTracking?: item: { slot=%d/%llu, buffer=%p }, "
            "slot: { slot=%d/%llu, buffer=%p }",
            item->mBuf, item->mFrameNumber,
            (item->mGraphicBuffer.get() ? item->mGraphicBuffer->handle : 0),
            item->mBuf, slot.mFrameNumber,
            (slot.mGraphicBuffer.get() ? slot.mGraphicBuffer->handle : 0));

    // Compare item with its original buffer slot.  We can check the slot
    // as the buffer would not be moved to a different slot by the producer.
    return (slot.mGraphicBuffer != NULL &&
            item->mGraphicBuffer->handle == slot.mGraphicBuffer->handle);
}

GonkBufferQueue::ProxyConsumerListener::ProxyConsumerListener(
        const wp<ConsumerListener>& consumerListener):
        mConsumerListener(consumerListener) {}

GonkBufferQueue::ProxyConsumerListener::~ProxyConsumerListener() {}

void GonkBufferQueue::ProxyConsumerListener::onFrameAvailable() {
    sp<ConsumerListener> listener(mConsumerListener.promote());
    if (listener != NULL) {
        listener->onFrameAvailable();
    }
}

void GonkBufferQueue::ProxyConsumerListener::onBuffersReleased() {
    sp<ConsumerListener> listener(mConsumerListener.promote());
    if (listener != NULL) {
        listener->onBuffersReleased();
    }
}

}; // namespace android
