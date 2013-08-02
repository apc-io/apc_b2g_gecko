/*
 * some copy right message
 * \author Nguyen Thanh Trung <nguyenthanh.trung@nomovok.vn>
 */

#include <assert.h>

#include "MouseCursorSupport.h"
#include "PNGReader.h"

#include "gfxASurface.h"
#include "LayerManagerOGL.h"
#include "ImageLayerOGL.h"
#include "ImageContainer.h"

using namespace mozilla;
using namespace mozilla::gl;
using namespace mozilla::layers;

class MouseCursorSupportPrivate {
public:
	MouseCursorSupportPrivate();
	~MouseCursorSupportPrivate();

	// this is used to load cursor data
	bool InitCursorData();
	// this is used to prepare ImageContainer & Image
	bool PrepareCursorImage();
	void RenderOnLayerManager(LayerManager * aManager);

public:
	int mX;
	int mY;
	bool mVisible;
	int mHotSpotX;
	int mHotSpotY;
	PNGImageData *mCursorImageData;
	nsRefPtr<gfxASurface> mCursorSurface;
	nsRefPtr<ImageContainer> mImageContainer;
    already_AddRefed<Image> mCursorImage;
};

MouseCursorSupportPrivate::MouseCursorSupportPrivate():
	mX(0), mY(0), mVisible(false),
	mHotSpotX(5), mHotSpotY(0),
	mCursorImageData(0),
	mCursorSurface(0),
	mImageContainer(0),
	mCursorImage(0)
{}

MouseCursorSupportPrivate::~MouseCursorSupportPrivate() {
	if (mCursorImageData != 0) {
		mCursorImageData->Dispose();
		delete mCursorImageData;
	}
}

bool
MouseCursorSupportPrivate::InitCursorData() {
	// for now, we load this from file
	if (mCursorImageData == 0) {
		PNGReader reader;
		mCursorImageData = reader.ReadFile("/system/media/cursor.png");
		if (mCursorImageData == 0) {
			return false;
		}
	}

	if (mCursorSurface == 0) {
        mCursorSurface = new gfxImageSurface(
        	mCursorImageData->imageData,
        	mCursorImageData->imageSize,
            mCursorImageData->stride,
            mCursorImageData->imageFormat);
        if (mCursorSurface == 0) {
        	return false;
        }
	}
	return true;
}

bool
MouseCursorSupportPrivate::PrepareCursorImage() {
	if (mImageContainer == 0) {
		mImageContainer = new ImageContainer(ImageContainer::DISABLE_ASYNC);
		if (mImageContainer == 0) {
			return false;
		}
	}

    if (mCursorImage.get() == 0) {
    	if (mCursorSurface == 0) { // we need the surface to have the data
    		return false;
    	}

        ImageFormat fmt[] = { CAIRO_SURFACE };
        mCursorImage = mImageContainer->CreateImage(fmt, 1);

        if (mCursorImage.get() == 0) {
            return false;
        }

        CairoImage::Data data = {
        	mCursorSurface,
        	mCursorSurface->GetSize()
        };
        CairoImage *img = static_cast<CairoImage*>(mCursorImage.get());
        img->SetData(data);

        mImageContainer->SetCurrentImage(img);
    }
    return true;
}

void
MouseCursorSupportPrivate::RenderOnLayerManager(LayerManager * aManager) {
	if (!InitCursorData()) {
		return;
	}

	if (!PrepareCursorImage()) {
		return;
	}

	already_AddRefed<ImageLayer> layer = aManager->CreateImageLayer();
    ImageLayerOGL *glLayer = static_cast<ImageLayerOGL*>(layer.get());
    glLayer->SetContainer(mImageContainer);
    gfxIntSize cursorSize = mCursorImage.get()->GetSize();
    nsIntRect visibleRect(0, 0, cursorSize.width, cursorSize.height);
    glLayer->SetVisibleRegion(visibleRect);

    GLContext *gl = glLayer->gl();
    nsIntPoint point(-mX + mHotSpotX, -mY + mHotSpotY);

    // this is tricky since we don't know what is the previous buffer. Anyway to query that?
    glLayer->RenderLayer(0, point);
    if (gl->IsDoubleBuffered()) {
        // well, just for sure
        glLayer->RenderLayer(1, point);
    }
}

/////////////////////////////////////////////////////////
MouseCursorSupport::MouseCursorSupport():
	mPriv(new MouseCursorSupportPrivate())
{
	assert(mPriv != 0);
}

MouseCursorSupport::~MouseCursorSupport() {
	delete mPriv;
}

bool
MouseCursorSupport::SetVisible(bool aVisible) {
	if (aVisible == mPriv->mVisible) {
		return false;
	}

	mPriv->mVisible = aVisible;

	return true;
}

bool
MouseCursorSupport::SetPosition(int aX, int aY) {
	bool changed = (aX != mPriv->mX) || (aY != mPriv->mY);
	if (!changed) {
		return false;
	}

	mPriv->mX = aX;
	mPriv->mY = aY;

	return true;
}

void
MouseCursorSupport::Render(mozilla::layers::LayerManager* aManager, nsIntRect aRect) {
	// for now, we only support openGL backend
	if (aManager == 0 || aManager->GetBackendType() != LAYERS_OPENGL) {
		return;
	}

	if (!mPriv->mVisible) {
		return; // not visible => no need to render
	}

	mPriv->RenderOnLayerManager(aManager);
}

