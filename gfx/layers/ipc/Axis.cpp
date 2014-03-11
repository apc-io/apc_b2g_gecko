/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set sw=2 ts=8 et tw=80 : */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "Axis.h"
#include <math.h>                       // for fabsf, pow, powf
#include <algorithm>                    // for max
#include "AsyncPanZoomController.h"     // for AsyncPanZoomController
#include "FrameMetrics.h"               // for FrameMetrics
#include "mozilla/Attributes.h"         // for MOZ_FINAL
#include "mozilla/Preferences.h"        // for Preferences
#include "mozilla/gfx/Rect.h"           // for RoundedIn
#include "mozilla/mozalloc.h"           // for operator new
#include "nsMathUtils.h"                // for NS_lround
#include "nsThreadUtils.h"              // for NS_DispatchToMainThread, etc
#include "nscore.h"                     // for NS_IMETHOD
#include "gfxPrefs.h"                   // for the preferences

namespace mozilla {
namespace layers {

/**
 * These are the preferences that control the behavior of APZ
 */

/**
 * "apz.max_event_acceleration"
 *
 * Maximum acceleration that can happen between two frames. Velocity is
 * throttled if it's above this. This may happen if a time delta is very low,
 * or we get a touch point very far away from the previous position for some
 * reason.
 *
 * The default value is 999.0f, set in gfxPrefs.h
 */

/**
 * "apz.fling_friction"
 *
 * Amount of friction applied during flings.
 *
 * The default value is 0.002f, set in gfxPrefs.h
 */

/**
 * "apz.fling_stopped_threshold"
 *
 * When flinging, if the velocity goes below this number, we just stop the
 * animation completely. This is to prevent asymptotically approaching 0
 * velocity and rerendering unnecessarily.
 *
 * The default value is 0.01f, set in gfxPrefs.h.
 */

/**
 * "apz.max_velocity_queue_size"
 *
 * Maximum size of velocity queue. The queue contains last N velocity records.
 * On touch end we calculate the average velocity in order to compensate
 * touch/mouse drivers misbehaviour.
 *
 * The default value is 5, set in gfxPrefs.h
 */

/**
 * "apz.max_velocity_pixels_per_ms"
 *
 * Maximum velocity in pixels per millisecond.  Velocity will be capped at this
 * value if a faster fling occurs.  Negative values indicate unlimited velocity.
 *
 * The default value is -1.0f, set in gfxPrefs.h
 */

Axis::Axis(AsyncPanZoomController* aAsyncPanZoomController)
  : mPos(0),
    mVelocity(0.0f),
    mAxisLocked(false),
    mAsyncPanZoomController(aAsyncPanZoomController)
{
}

void Axis::UpdateWithTouchAtDevicePoint(int32_t aPos, const TimeDuration& aTimeDelta) {
  float newVelocity = mAxisLocked ? 0 : (mPos - aPos) / aTimeDelta.ToMilliseconds();
  if (gfxPrefs::APZMaxVelocity() > 0.0f) {
    newVelocity = std::min(newVelocity, gfxPrefs::APZMaxVelocity());
  }

  mVelocity = newVelocity;
  mPos = aPos;

  // Limit queue size pased on pref
  mVelocityQueue.AppendElement(mVelocity);
  if (mVelocityQueue.Length() > gfxPrefs::APZMaxVelocityQueueSize()) {
    mVelocityQueue.RemoveElementAt(0);
  }
}

void Axis::StartTouch(int32_t aPos) {
  mStartPos = aPos;
  mPos = aPos;
  mAxisLocked = false;
}

float Axis::AdjustDisplacement(float aDisplacement, float& aOverscrollAmountOut) {
  if (mAxisLocked) {
    aOverscrollAmountOut = 0;
    return 0;
  }

  float displacement = aDisplacement;

  // If this displacement will cause an overscroll, throttle it. Can potentially
  // bring it to 0 even if the velocity is high.
  if (DisplacementWillOverscroll(displacement) != OVERSCROLL_NONE) {
    // No need to have a velocity along this axis anymore; it won't take us
    // anywhere, so we're just spinning needlessly.
    mVelocity = 0.0f;
    aOverscrollAmountOut = DisplacementWillOverscrollAmount(displacement);
    displacement -= aOverscrollAmountOut;
  }
  return displacement;
}

float Axis::PanDistance() {
  return fabsf(mPos - mStartPos);
}

float Axis::PanDistance(float aPos) {
  return fabsf(aPos - mStartPos);
}

void Axis::EndTouch() {
  // Calculate the mean velocity and empty the queue.
  int count = mVelocityQueue.Length();
  if (count) {
    mVelocity = 0;
    while (!mVelocityQueue.IsEmpty()) {
      mVelocity += mVelocityQueue[0];
      mVelocityQueue.RemoveElementAt(0);
    }
    mVelocity /= count;
  }
}

void Axis::CancelTouch() {
  mVelocity = 0.0f;
  while (!mVelocityQueue.IsEmpty()) {
    mVelocityQueue.RemoveElementAt(0);
  }
}

bool Axis::Scrollable() {
    if (mAxisLocked) {
        return false;
    }
    return GetCompositionLength() < GetPageLength();
}

bool Axis::FlingApplyFrictionOrCancel(const TimeDuration& aDelta) {
  if (fabsf(mVelocity) <= gfxPrefs::APZFlingStoppedThreshold()) {
    // If the velocity is very low, just set it to 0 and stop the fling,
    // otherwise we'll just asymptotically approach 0 and the user won't
    // actually see any changes.
    mVelocity = 0.0f;
    return false;
  } else {
    mVelocity *= pow(1.0f - gfxPrefs::APZFlingFriction(), float(aDelta.ToMilliseconds()));
  }
  return true;
}

Axis::Overscroll Axis::GetOverscroll() {
  // If the current pan takes the window to the left of or above the current
  // page rect.
  bool minus = GetOrigin() < GetPageStart();
  // If the current pan takes the window to the right of or below the current
  // page rect.
  bool plus = GetCompositionEnd() > GetPageEnd();
  if (minus && plus) {
    return OVERSCROLL_BOTH;
  }
  if (minus) {
    return OVERSCROLL_MINUS;
  }
  if (plus) {
    return OVERSCROLL_PLUS;
  }
  return OVERSCROLL_NONE;
}

float Axis::GetExcess() {
  switch (GetOverscroll()) {
  case OVERSCROLL_MINUS: return GetOrigin() - GetPageStart();
  case OVERSCROLL_PLUS: return GetCompositionEnd() - GetPageEnd();
  case OVERSCROLL_BOTH: return (GetCompositionEnd() - GetPageEnd()) +
                               (GetPageStart() - GetOrigin());
  default: return 0;
  }
}

Axis::Overscroll Axis::DisplacementWillOverscroll(float aDisplacement) {
  // If the current pan plus a displacement takes the window to the left of or
  // above the current page rect.
  bool minus = GetOrigin() + aDisplacement < GetPageStart();
  // If the current pan plus a displacement takes the window to the right of or
  // below the current page rect.
  bool plus = GetCompositionEnd() + aDisplacement > GetPageEnd();
  if (minus && plus) {
    return OVERSCROLL_BOTH;
  }
  if (minus) {
    return OVERSCROLL_MINUS;
  }
  if (plus) {
    return OVERSCROLL_PLUS;
  }
  return OVERSCROLL_NONE;
}

float Axis::DisplacementWillOverscrollAmount(float aDisplacement) {
  switch (DisplacementWillOverscroll(aDisplacement)) {
  case OVERSCROLL_MINUS: return (GetOrigin() + aDisplacement) - GetPageStart();
  case OVERSCROLL_PLUS: return (GetCompositionEnd() + aDisplacement) - GetPageEnd();
  // Don't handle overscrolled in both directions; a displacement can't cause
  // this, it must have already been zoomed out too far.
  default: return 0;
  }
}

float Axis::ScaleWillOverscrollAmount(float aScale, float aFocus) {
  float originAfterScale = (GetOrigin() + aFocus) - (aFocus / aScale);

  bool both = ScaleWillOverscrollBothSides(aScale);
  bool minus = originAfterScale < GetPageStart();
  bool plus = (originAfterScale + (GetCompositionLength() / aScale)) > GetPageEnd();

  if ((minus && plus) || both) {
    // If we ever reach here it's a bug in the client code.
    MOZ_ASSERT(false, "In an OVERSCROLL_BOTH condition in ScaleWillOverscrollAmount");
    return 0;
  }
  if (minus) {
    return originAfterScale - GetPageStart();
  }
  if (plus) {
    return originAfterScale + (GetCompositionLength() / aScale) - GetPageEnd();
  }
  return 0;
}

float Axis::GetVelocity() {
  return mAxisLocked ? 0 : mVelocity;
}

float Axis::GetCompositionEnd() {
  return GetOrigin() + GetCompositionLength();
}

float Axis::GetPageEnd() {
  return GetPageStart() + GetPageLength();
}

float Axis::GetOrigin() {
  CSSPoint origin = mAsyncPanZoomController->GetFrameMetrics().mScrollOffset;
  return GetPointOffset(origin);
}

float Axis::GetCompositionLength() {
  const FrameMetrics& metrics = mAsyncPanZoomController->GetFrameMetrics();
  CSSRect cssCompositedRect = metrics.CalculateCompositedRectInCssPixels();
  return GetRectLength(cssCompositedRect);
}

float Axis::GetPageStart() {
  CSSRect pageRect = mAsyncPanZoomController->GetFrameMetrics().mScrollableRect;
  return GetRectOffset(pageRect);
}

float Axis::GetPageLength() {
  CSSRect pageRect = mAsyncPanZoomController->GetFrameMetrics().mScrollableRect;
  return GetRectLength(pageRect);
}

bool Axis::ScaleWillOverscrollBothSides(float aScale) {
  const FrameMetrics& metrics = mAsyncPanZoomController->GetFrameMetrics();

  CSSToScreenScale scale(metrics.mZoom.scale * aScale);
  CSSRect cssCompositionBounds = metrics.mCompositionBounds / scale;

  return GetRectLength(metrics.mScrollableRect) < GetRectLength(cssCompositionBounds);
}

AxisX::AxisX(AsyncPanZoomController* aAsyncPanZoomController)
  : Axis(aAsyncPanZoomController)
{

}

float AxisX::GetPointOffset(const CSSPoint& aPoint)
{
  return aPoint.x;
}

float AxisX::GetRectLength(const CSSRect& aRect)
{
  return aRect.width;
}

float AxisX::GetRectOffset(const CSSRect& aRect)
{
  return aRect.x;
}

AxisY::AxisY(AsyncPanZoomController* aAsyncPanZoomController)
  : Axis(aAsyncPanZoomController)
{

}

float AxisY::GetPointOffset(const CSSPoint& aPoint)
{
  return aPoint.y;
}

float AxisY::GetRectLength(const CSSRect& aRect)
{
  return aRect.height;
}

float AxisY::GetRectOffset(const CSSRect& aRect)
{
  return aRect.y;
}

}
}
