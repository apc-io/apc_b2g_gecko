/*
 * some copy right message
 * \author Nguyen Thanh Trung <nguyenthanh.trung@nomovok.vn>
 */

#ifndef GECKO_MOUSE_CURSOR_SUPPORT_H
#define GECKO_MOUSE_CURSOR_SUPPORT_H

#include "nsRect.h"

namespace mozilla {
namespace layers {

class LayerManager;

}
}

class MouseCursorSupportPrivate;

class MouseCursorSupport {
public:
	MouseCursorSupport();
	~MouseCursorSupport();

	/*
	 * \brief set the visible state of mouse cursor
	 * \param visible visible state to set
	 * \return true if visible is changed, false if nothing is changed
	 */
	bool SetVisible(bool aVisible);

	/*
	 * \brief set mouse position
	 * \param aX x coordinate
	 * \param aY y coordinate
	 * \return true if the location is changed, false otherwise
	 */
	bool SetPosition(int aX, int aY);

	/*
	 * \render mouse cursor to the layermanager
	 * \param @see nsIWidget::DrawWindowOverlay
	 */
	void Render(mozilla::layers::LayerManager* aManager, nsIntRect aRect);

private:
	MouseCursorSupportPrivate * mPriv;
};

#endif // GECKO_MOUSE_CURSOR_SUPPORT_H

