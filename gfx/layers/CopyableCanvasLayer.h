/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef GFX_COPYABLECANVASLAYER_H
#define GFX_COPYABLECANVASLAYER_H

#include <stdint.h>                     // for uint32_t
#include "GLContextTypes.h"             // for GLContext
#include "Layers.h"                     // for CanvasLayer, etc
#include "gfxASurface.h"                // for gfxASurface
#include "gfxContext.h"                 // for gfxContext, etc
#include "gfxTypes.h"
#include "gfxPlatform.h"                // for gfxImageFormat
#include "mozilla/Assertions.h"         // for MOZ_ASSERT, etc
#include "mozilla/Preferences.h"        // for Preferences
#include "mozilla/RefPtr.h"             // for RefPtr
#include "mozilla/gfx/2D.h"             // for DrawTarget
#include "mozilla/mozalloc.h"           // for operator delete, etc
#include "nsAutoPtr.h"                  // for nsRefPtr
#include "nsISupportsImpl.h"            // for MOZ_COUNT_CTOR, etc

namespace mozilla {

namespace gfx {
class SurfaceStream;
class SharedSurface;
class SurfaceFactory;
}

namespace layers {

class CanvasClientWebGL;

/**
 * A shared CanvasLayer implementation that supports copying
 * its contents into a gfxASurface using UpdateSurface.
 */
class CopyableCanvasLayer : public CanvasLayer
{
public:
  CopyableCanvasLayer(LayerManager* aLayerManager, void *aImplData);
  virtual ~CopyableCanvasLayer();

  virtual void Initialize(const Data& aData);

  virtual bool IsDataValid(const Data& aData);

protected:
  void PaintWithOpacity(gfx::DrawTarget* aTarget,
                        float aOpacity,
                        gfx::SourceSurface* aMaskSurface,
                        gfx::CompositionOp aOperator = gfx::CompositionOp::OP_OVER);

  void UpdateTarget(gfx::DrawTarget* aDestTarget = nullptr,
                    gfx::SourceSurface* aMaskSurface = nullptr);

  RefPtr<gfx::SourceSurface> mSurface;
  nsRefPtr<gfxASurface> mDeprecatedSurface;
  nsRefPtr<mozilla::gl::GLContext> mGLContext;
  mozilla::RefPtr<mozilla::gfx::DrawTarget> mDrawTarget;

  RefPtr<gfx::SurfaceStream> mStream;

  uint32_t mCanvasFramebuffer;

  bool mIsGLAlphaPremult;
  bool mNeedsYFlip;

  RefPtr<gfx::DataSourceSurface> mCachedTempSurface;
  nsRefPtr<gfxImageSurface> mDeprecatedCachedTempSurface;
  gfx::IntSize mCachedSize;
  gfx::SurfaceFormat mCachedFormat;
  gfxImageFormat mDeprecatedCachedFormat;

  gfx::DataSourceSurface* GetTempSurface(const gfx::IntSize& aSize,
                                         const gfx::SurfaceFormat aFormat);

  void DiscardTempSurface();

  /* Deprecated thebes methods */
protected:
  void DeprecatedPaintWithOpacity(gfxContext* aContext,
                                  float aOpacity,
                                  Layer* aMaskLayer,
                                  gfxContext::GraphicsOperator aOperator = gfxContext::OPERATOR_OVER);

  void DeprecatedUpdateSurface(gfxASurface* aDestSurface = nullptr,
                               Layer* aMaskLayer = nullptr);

  gfxImageSurface* DeprecatedGetTempSurface(const gfx::IntSize& aSize,
                                            const gfxImageFormat aFormat);

};

}
}

#endif
