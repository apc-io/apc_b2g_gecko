/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsAlgorithm.h"
#include "WebMBufferedParser.h"
#include "nsTimeRanges.h"
#include "nsThreadUtils.h"
#include <algorithm>

namespace mozilla {

static const double NS_PER_S = 1e9;

static uint32_t
VIntLength(unsigned char aFirstByte, uint32_t* aMask)
{
  uint32_t count = 1;
  uint32_t mask = 1 << 7;
  while (count < 8) {
    if ((aFirstByte & mask) != 0) {
      break;
    }
    mask >>= 1;
    count += 1;
  }
  if (aMask) {
    *aMask = mask;
  }
  NS_ASSERTION(count >= 1 && count <= 8, "Insane VInt length.");
  return count;
}

void WebMBufferedParser::Append(const unsigned char* aBuffer, uint32_t aLength,
                                  nsTArray<WebMTimeDataOffset>& aMapping,
                                  ReentrantMonitor& aReentrantMonitor)
{
  static const unsigned char CLUSTER_ID[] = { 0x1f, 0x43, 0xb6, 0x75 };
  static const unsigned char TIMECODE_ID = 0xe7;
  static const unsigned char BLOCKGROUP_ID = 0xa0;
  static const unsigned char BLOCK_ID = 0xa1;
  static const unsigned char SIMPLEBLOCK_ID = 0xa3;

  const unsigned char* p = aBuffer;

  // Parse each byte in aBuffer one-by-one, producing timecodes and updating
  // aMapping as we go.  Parser pauses at end of stream (which may be at any
  // point within the parse) and resumes parsing the next time Append is
  // called with new data.
  while (p < aBuffer + aLength) {
    switch (mState) {
    case CLUSTER_SYNC:
      if (*p++ == CLUSTER_ID[mClusterIDPos]) {
        mClusterIDPos += 1;
      } else {
        mClusterIDPos = 0;
      }
      // Cluster ID found, it's likely this is a valid sync point.  If this
      // is a spurious match, the later parse steps will encounter an error
      // and return to CLUSTER_SYNC.
      if (mClusterIDPos == sizeof(CLUSTER_ID)) {
        mClusterIDPos = 0;
        mState = READ_VINT;
        mNextState = TIMECODE_SYNC;
      }
      break;
    case READ_VINT: {
      unsigned char c = *p++;
      uint32_t mask;
      mVIntLength = VIntLength(c, &mask);
      mVIntLeft = mVIntLength - 1;
      mVInt = c & ~mask;
      mState = READ_VINT_REST;
      break;
    }
    case READ_VINT_REST:
      if (mVIntLeft) {
        mVInt <<= 8;
        mVInt |= *p++;
        mVIntLeft -= 1;
      } else {
        mState = mNextState;
      }
      break;
    case TIMECODE_SYNC:
      if (*p++ != TIMECODE_ID) {
        p -= 1;
        mState = CLUSTER_SYNC;
        break;
      }
      mClusterTimecode = 0;
      mState = READ_VINT;
      mNextState = READ_CLUSTER_TIMECODE;
      break;
    case READ_CLUSTER_TIMECODE:
      if (mVInt) {
        mClusterTimecode <<= 8;
        mClusterTimecode |= *p++;
        mVInt -= 1;
      } else {
        mState = ANY_BLOCK_SYNC;
      }
      break;
    case ANY_BLOCK_SYNC: {
      unsigned char c = *p++;
      if (c == BLOCKGROUP_ID) {
        mState = READ_VINT;
        mNextState = ANY_BLOCK_SYNC;
      } else if (c == SIMPLEBLOCK_ID || c == BLOCK_ID) {
        mBlockOffset = mCurrentOffset + (p - aBuffer) - 1;
        mState = READ_VINT;
        mNextState = READ_BLOCK;
      } else {
        uint32_t length = VIntLength(c, nullptr);
        if (length == 4) {
          p -= 1;
          mState = CLUSTER_SYNC;
        } else {
          mState = READ_VINT;
          mNextState = SKIP_ELEMENT;
        }
      }
      break;
    }
    case READ_BLOCK:
      mBlockSize = mVInt;
      mBlockTimecode = 0;
      mBlockTimecodeLength = 2;
      mState = READ_VINT;
      mNextState = READ_BLOCK_TIMECODE;
      break;
    case READ_BLOCK_TIMECODE:
      if (mBlockTimecodeLength) {
        mBlockTimecode <<= 8;
        mBlockTimecode |= *p++;
        mBlockTimecodeLength -= 1;
      } else {
        // It's possible we've parsed this data before, so avoid inserting
        // duplicate WebMTimeDataOffset entries.
        {
          ReentrantMonitorAutoEnter mon(aReentrantMonitor);
          uint32_t idx;
          if (!aMapping.GreatestIndexLtEq(mBlockOffset, idx)) {
            WebMTimeDataOffset entry(mBlockOffset, mClusterTimecode + mBlockTimecode);
            aMapping.InsertElementAt(idx, entry);
          }
        }

        // Skip rest of block header and the block's payload.
        mBlockSize -= mVIntLength;
        mBlockSize -= 2;
        mSkipBytes = uint32_t(mBlockSize);
        mState = SKIP_DATA;
        mNextState = ANY_BLOCK_SYNC;
      }
      break;
    case SKIP_DATA:
      if (mSkipBytes) {
        uint32_t left = aLength - (p - aBuffer);
        left = std::min(left, mSkipBytes);
        p += left;
        mSkipBytes -= left;
      } else {
        mState = mNextState;
      }
      break;
    case SKIP_ELEMENT:
      mSkipBytes = uint32_t(mVInt);
      mState = SKIP_DATA;
      mNextState = ANY_BLOCK_SYNC;
      break;
    }
  }

  NS_ASSERTION(p == aBuffer + aLength, "Must have parsed to end of data.");
  mCurrentOffset += aLength;
}

bool WebMBufferedState::CalculateBufferedForRange(int64_t aStartOffset, int64_t aEndOffset,
                                                    uint64_t* aStartTime, uint64_t* aEndTime)
{
  ReentrantMonitorAutoEnter mon(mReentrantMonitor);

  // Find the first WebMTimeDataOffset at or after aStartOffset.
  uint32_t start;
  mTimeMapping.GreatestIndexLtEq(aStartOffset, start);
  if (start == mTimeMapping.Length()) {
    return false;
  }

  // Find the first WebMTimeDataOffset at or before aEndOffset.
  uint32_t end;
  if (!mTimeMapping.GreatestIndexLtEq(aEndOffset, end) && end > 0) {
    // No exact match, so adjust end to be the first entry before
    // aEndOffset.
    end -= 1;
  }

  // Range is empty.
  if (end <= start) {
    return false;
  }

  NS_ASSERTION(mTimeMapping[start].mOffset >= aStartOffset &&
               mTimeMapping[end].mOffset <= aEndOffset,
               "Computed time range must lie within data range.");
  if (start > 0) {
    NS_ASSERTION(mTimeMapping[start - 1].mOffset <= aStartOffset,
                 "Must have found least WebMTimeDataOffset for start");
  }
  if (end < mTimeMapping.Length() - 1) {
    NS_ASSERTION(mTimeMapping[end + 1].mOffset >= aEndOffset,
                 "Must have found greatest WebMTimeDataOffset for end");
  }

  // The timestamp of the first media sample, in ns. We must subtract this
  // from the ranges' start and end timestamps, so that those timestamps are
  // normalized in the range [0,duration].

  *aStartTime = mTimeMapping[start].mTimecode;
  *aEndTime = mTimeMapping[end].mTimecode;
  return true;
}

void WebMBufferedState::NotifyDataArrived(const char* aBuffer, uint32_t aLength, int64_t aOffset)
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  uint32_t idx;
  if (!mRangeParsers.GreatestIndexLtEq(aOffset, idx)) {
    // If the incoming data overlaps an already parsed range, adjust the
    // buffer so that we only reparse the new data.  It's also possible to
    // have an overlap where the end of the incoming data is within an
    // already parsed range, but we don't bother handling that other than by
    // avoiding storing duplicate timecodes when the parser runs.
    if (idx != mRangeParsers.Length() && mRangeParsers[idx].mStartOffset <= aOffset) {
      // Complete overlap, skip parsing.
      if (aOffset + aLength <= mRangeParsers[idx].mCurrentOffset) {
        return;
      }

      // Partial overlap, adjust the buffer to parse only the new data.
      int64_t adjust = mRangeParsers[idx].mCurrentOffset - aOffset;
      NS_ASSERTION(adjust >= 0, "Overlap detection bug.");
      aBuffer += adjust;
      aLength -= uint32_t(adjust);
    } else {
      mRangeParsers.InsertElementAt(idx, WebMBufferedParser(aOffset));
    }
  }

  mRangeParsers[idx].Append(reinterpret_cast<const unsigned char*>(aBuffer),
                            aLength,
                            mTimeMapping,
                            mReentrantMonitor);

  // Merge parsers with overlapping regions and clean up the remnants.
  uint32_t i = 0;
  while (i + 1 < mRangeParsers.Length()) {
    if (mRangeParsers[i].mCurrentOffset >= mRangeParsers[i + 1].mStartOffset) {
      mRangeParsers[i + 1].mStartOffset = mRangeParsers[i].mStartOffset;
      mRangeParsers.RemoveElementAt(i);
    } else {
      i += 1;
    }
  }
}

} // namespace mozilla

