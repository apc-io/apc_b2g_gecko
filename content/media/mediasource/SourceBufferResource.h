/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef MOZILLA_SOURCEBUFFERRESOURCE_H_
#define MOZILLA_SOURCEBUFFERRESOURCE_H_

#include <algorithm>
#include "MediaCache.h"
#include "MediaResource.h"
#include "mozilla/Attributes.h"
#include "mozilla/ReentrantMonitor.h"
#include "nsCOMPtr.h"
#include "nsError.h"
#include "nsIPrincipal.h"
#include "nsStringGlue.h"
#include "nsTArray.h"
#include "nsDeque.h"
#include "nscore.h"

class nsIStreamListener;

namespace mozilla {

class MediaDecoder;

namespace dom {

class SourceBuffer;

}  // namespace dom

class SourceBufferResource MOZ_FINAL : public MediaResource
{
private:
  // A SourceBufferResource has a queue containing the data
  // that is appended to it. The queue holds instances of
  // ResourceItem which is an array of the bytes. Appending
  // data to the SourceBufferResource pushes this onto the
  // queue. As items are played they are taken off the front
  // of the queue.
  // Data is evicted once it reaches a size threshold. This
  // pops the items off the front of the queue and deletes it.
  // If an eviction happens then the MediaSource is notified
  // (done in SourceBuffer::AppendData) which then requests
  // all SourceBuffers to evict data up to approximately
  // the same timepoint.
  struct ResourceItem {
    ResourceItem(uint8_t const* aData, uint32_t aSize) {
      mData.AppendElements(aData, aSize);
    }
    nsTArray<uint8_t> mData;
  };

  class ResourceQueueDeallocator : public nsDequeFunctor {
    virtual void* operator() (void* anObject) {
      delete static_cast<ResourceItem*>(anObject);
      return nullptr;
    }
  };

  class ResourceQueue : private nsDeque {
  private:
    // Logical offset into the resource of the first element
    // in the queue.
    uint64_t mOffset;

  public:
    ResourceQueue() :
      nsDeque(new ResourceQueueDeallocator()),
      mOffset(0)
    {
    }

    // Clears all items from the queue
    inline void Clear() {
      return nsDeque::Erase();
    }

    // Returns the number of items in the queue
    inline uint32_t GetSize() {
      return nsDeque::GetSize();
    }

    // Returns the logical byte offset of the start of the data.
    inline uint64_t GetOffset() {
      return mOffset;
    }

    inline ResourceItem* ResourceAt(uint32_t aIndex) {
      return static_cast<ResourceItem*>(nsDeque::ObjectAt(aIndex));
    }

    // Returns the length of all items in the queue plus the offset.
    // This is the logical length of the resource.
    inline uint64_t GetLength() {
      uint64_t s = mOffset;
      for (uint32_t i = 0; i < GetSize(); ++i) {
        ResourceItem* item = ResourceAt(i);
        s += item->mData.Length();
      }
      return s;
    }

    // Returns the index of the resource that contains the given
    // logical offset. aResourceOffset will contain the offset into
    // the resource at the given index returned if it is not null.  If
    // no such resource exists, returns GetSize() and aOffset is
    // untouched.
    inline uint32_t GetAtOffset(uint64_t aOffset, uint32_t *aResourceOffset) {
      uint64_t offset = mOffset;
      for (uint32_t i = 0; i < GetSize(); ++i) {
        ResourceItem* item = ResourceAt(i);
        // If the item contains the start of the offset we want to
        // break out of the loop.
        if (item->mData.Length() + offset > aOffset) {
          if (aResourceOffset) {
            *aResourceOffset = aOffset - offset;
          }
          return i;
        }
        offset += item->mData.Length();
      }
      return GetSize();
    }

    // Copies aCount bytes from aOffset in the queue into aDest.
    inline void CopyData(uint64_t aOffset, uint32_t aCount, char* aDest) {
      uint32_t offset = 0;
      uint32_t start = GetAtOffset(aOffset, &offset);
      uint32_t end = std::min(GetAtOffset(aOffset + aCount, nullptr) + 1, GetSize());
      for (uint32_t i = start; i < end; ++i) {
        ResourceItem* item = ResourceAt(i);
        uint32_t bytes = std::min(aCount, item->mData.Length() - offset);
        if (bytes != 0) {
          memcpy(aDest, &item->mData[offset], bytes);
          offset = 0;
          aCount -= bytes;
          aDest += bytes;
        }
      }
    }

    inline void PushBack(ResourceItem* aItem) {
      nsDeque::Push(aItem);
    }

    inline void PushFront(ResourceItem* aItem) {
      nsDeque::PushFront(aItem);
    }

    inline ResourceItem* PopBack() {
      return static_cast<ResourceItem*>(nsDeque::Pop());
    }

    inline ResourceItem* PopFront() {
      return static_cast<ResourceItem*>(nsDeque::PopFront());
    }

    // Evict data in queue if the total queue size is greater than
    // aThreshold past the offset. Returns true if some data was
    // actually evicted.
    inline bool Evict(uint64_t aOffset, uint32_t aThreshold) {
      bool evicted = false;
      while (GetLength() - mOffset > aThreshold) {
        ResourceItem* item = ResourceAt(0);
        if (item->mData.Length() + mOffset > aOffset) {
          break;
        }
        mOffset += item->mData.Length();
        delete PopFront();
        evicted = true;
      }
      return evicted;
    }
  };

public:
  SourceBufferResource(nsIPrincipal* aPrincipal,
                       const nsACString& aType);
  ~SourceBufferResource();

  virtual nsresult Close() MOZ_OVERRIDE;
  virtual void Suspend(bool aCloseImmediately) MOZ_OVERRIDE {}
  virtual void Resume() MOZ_OVERRIDE {}

  virtual already_AddRefed<nsIPrincipal> GetCurrentPrincipal() MOZ_OVERRIDE
  {
    return nsCOMPtr<nsIPrincipal>(mPrincipal).forget();
  }

  virtual already_AddRefed<MediaResource> CloneData(MediaDecoder* aDecoder) MOZ_OVERRIDE
  {
    return nullptr;
  }

  virtual void SetReadMode(MediaCacheStream::ReadMode aMode) MOZ_OVERRIDE {}
  virtual void SetPlaybackRate(uint32_t aBytesPerSecond) MOZ_OVERRIDE {}
  virtual nsresult Read(char* aBuffer, uint32_t aCount, uint32_t* aBytes) MOZ_OVERRIDE;
  virtual nsresult ReadAt(int64_t aOffset, char* aBuffer, uint32_t aCount, uint32_t* aBytes) MOZ_OVERRIDE;
  virtual nsresult Seek(int32_t aWhence, int64_t aOffset) MOZ_OVERRIDE;
  virtual void StartSeekingForMetadata() MOZ_OVERRIDE { }
  virtual void EndSeekingForMetadata() MOZ_OVERRIDE {}
  virtual int64_t Tell() MOZ_OVERRIDE { return mOffset; }
  virtual void Pin() MOZ_OVERRIDE {}
  virtual void Unpin() MOZ_OVERRIDE {}
  virtual double GetDownloadRate(bool* aIsReliable) MOZ_OVERRIDE { return 0; }
  virtual int64_t GetLength() MOZ_OVERRIDE { return mInputBuffer.GetLength(); }
  virtual int64_t GetNextCachedData(int64_t aOffset) MOZ_OVERRIDE { return aOffset; }
  virtual int64_t GetCachedDataEnd(int64_t aOffset) MOZ_OVERRIDE { return GetLength(); }
  virtual bool IsDataCachedToEndOfResource(int64_t aOffset) MOZ_OVERRIDE { return false; }
  virtual bool IsSuspendedByCache() MOZ_OVERRIDE { return false; }
  virtual bool IsSuspended() MOZ_OVERRIDE { return false; }
  virtual nsresult ReadFromCache(char* aBuffer, int64_t aOffset, uint32_t aCount) MOZ_OVERRIDE;
  virtual bool IsTransportSeekable() MOZ_OVERRIDE { return true; }
  virtual nsresult Open(nsIStreamListener** aStreamListener) MOZ_OVERRIDE { return NS_ERROR_FAILURE; }

  virtual nsresult GetCachedRanges(nsTArray<MediaByteRange>& aRanges) MOZ_OVERRIDE
  {
    aRanges.AppendElement(MediaByteRange(mInputBuffer.GetOffset(),
                                         mInputBuffer.GetLength()));
    return NS_OK;
  }

  virtual const nsCString& GetContentType() const MOZ_OVERRIDE { return mType; }

  // Used by SourceBuffer.
  void AppendData(const uint8_t* aData, uint32_t aLength);
  void Ended();
  // Remove data from resource if it holds more than the threshold
  // number of bytes. Returns true if some data was evicted.
  bool EvictData(uint32_t aThreshold);

  // Remove data from resource before the given offset.
  void EvictBefore(uint64_t aOffset);

private:
  nsCOMPtr<nsIPrincipal> mPrincipal;
  const nsAutoCString mType;

  // Provides synchronization between SourceBuffers and InputAdapters.
  // Protects all of the member variables below.  Read() will await a
  // Notify() (from Seek, AppendData, Ended, or Close) when insufficient
  // data is available in mData.
  ReentrantMonitor mMonitor;

  // The buffer holding resource data is a queue of ResourceItem's.
  ResourceQueue mInputBuffer;

  uint64_t mOffset;
  bool mClosed;
  bool mEnded;
};

} // namespace mozilla
#endif /* MOZILLA_SOURCEBUFFERRESOURCE_H_ */
