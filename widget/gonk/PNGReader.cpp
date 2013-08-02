/*
 * some copy right message
 * \author Nguyen Thanh Trung <nguyenthanh.trung@nomovok.vn>
 */

#include "PNGReader.h"
#include <cstdio>

#include "ui/FramebufferNativeWindow.h"
#include "hardware/gralloc.h"

using namespace android;

static const unsigned int PNGSIGSIZE = 8;
static const int UNDEFINED_DISPLAY_FORMAT = -999;
static int sDisplayFormat = UNDEFINED_DISPLAY_FORMAT;

PNGImageData::PNGImageData():
    imageData(0),
    imageFormat(gfxASurface::ImageFormatUnknown)
{}

void
PNGImageData::Dispose() {
    if (imageData != 0) {
        delete imageData;
    }
}

namespace {

static int getDisplayFormat();
static void pngReadFunc(png_structp pngPtr, png_bytep data, png_size_t length);
static bool validatePNGFile(std::FILE *f);
static PNGImageData * readPNGStream(std::FILE *f);
static PNGImageData * readInfoAndAllocPNGData(png_structp pngPtr, png_infop infoPtr);

int
getDisplayFormat() {
    int format;
    static sp<FramebufferNativeWindow> nativeWindow = new FramebufferNativeWindow();
    if (nativeWindow == 0) {
        return UNDEFINED_DISPLAY_FORMAT;
    }
    ANativeWindow *window = nativeWindow.get();
    window->query(window, NATIVE_WINDOW_FORMAT, &format);

    return format;
}

void
pngReadFunc(png_structp pngPtr, png_bytep data, png_size_t length) {
    png_voidp a = png_get_io_ptr(pngPtr);
    FILE *f = (FILE*)a;
    fread(data, 1, length, f);
}

bool
validatePNGFile(std::FILE *f) {
     //Allocate a buffer of 8 bytes, where we can put the file signature.
    png_byte pngsig[PNGSIGSIZE];
    int is_png = 0;

    //Read the 8 bytes from the stream into the sig buffer.
    // source.read((char*)pngsig, PNGSIGSIZE);
    int count = fread(pngsig, 1, PNGSIGSIZE, f);
    if (count < PNGSIGSIZE) {
        return false;
    }

    //Let LibPNG check the sig. If this function returns 0, everything is OK.
    is_png = png_sig_cmp(pngsig, 0, PNGSIGSIZE);
    return (is_png == 0);
}

PNGImageData *
readPNGStream(std::FILE *f) {
    if (!validatePNGFile(f)) {
        return 0;
    }

    png_structp pngPtr = png_create_read_struct(PNG_LIBPNG_VER_STRING, 0, 0, 0);
    if (pngPtr == 0) {
        return 0;
    }

    png_infop infoPtr = png_create_info_struct(pngPtr);
    if (infoPtr == 0) {
        png_destroy_read_struct(&pngPtr, (png_infopp)0, (png_infopp)0);
        return 0;
    }

    PNGImageData * data = 0;
    png_bytep * rowPtrs = 0;
    // error handling
    if (setjmp(png_jmpbuf(pngPtr))) {
        png_destroy_read_struct(&pngPtr, &infoPtr, (png_infopp)0);
        if (rowPtrs != 0) {
            delete []rowPtrs;
        }
        if (data != 0) {
            data->Dispose();
            delete data;
        }

        return 0;
    }

    // set read function
    png_set_read_fn(pngPtr, (png_voidp)f, pngReadFunc);

    // start reading
    png_set_sig_bytes(pngPtr, PNGSIGSIZE);

    data = readInfoAndAllocPNGData(pngPtr, infoPtr);
    if (data == 0) {
        return 0;
    }

    rowPtrs = new png_bytep[data->imageSize.height];
    if (rowPtrs == 0) {
        delete data;
        return 0;
    }

    png_uint_32 offset = 0;
    for (size_t i = 0 ; i < data->imageSize.height ; i++) {
        rowPtrs[i] = (png_bytep)data->imageData + offset;
        offset += data->stride;
    }

    // now the actual reading
    png_read_image(pngPtr, rowPtrs);

    delete[] (png_bytep)rowPtrs;
    png_destroy_read_struct(&pngPtr, &infoPtr, (png_infopp)0);

    return data;
}

PNGImageData *
readInfoAndAllocPNGData(png_structp pngPtr, png_infop infoPtr) {
    // read the header
    png_read_info(pngPtr, infoPtr);
    // get image size
    png_uint_32 width = png_get_image_width(pngPtr, infoPtr);
    png_uint_32 height = png_get_image_height(pngPtr, infoPtr);
    // get bit deps
    png_uint_32 bitdepth = png_get_bit_depth(pngPtr, infoPtr);
    // number of channels
    png_uint_32 channels = png_get_channels(pngPtr, infoPtr);
    
    // color format
    png_uint_32 colorType = png_get_color_type(pngPtr, infoPtr);
    switch (colorType) {
    case PNG_COLOR_TYPE_PALETTE:
        png_set_palette_to_rgb(pngPtr);
        channels = 3;
        break;
    case PNG_COLOR_TYPE_GRAY:
        if (bitdepth < 8) {
            png_set_expand_gray_1_2_4_to_8(pngPtr);
        }
        bitdepth = 8;
        break;
    }

    // ok, some byte order transformation to match display format
    if (sDisplayFormat == UNDEFINED_DISPLAY_FORMAT) {
        sDisplayFormat = getDisplayFormat();
    }

    switch (sDisplayFormat) {
    case HAL_PIXEL_FORMAT_BGRA_8888:
        png_set_bgr(pngPtr);
    case HAL_PIXEL_FORMAT_RGBA_8888:
    case HAL_PIXEL_FORMAT_RGBX_8888:
        png_set_filler(pngPtr, 0xFF, PNG_FILLER_AFTER);
        break;
    }

    // update alpha if needs
    if (png_get_valid(pngPtr, infoPtr, PNG_INFO_tRNS)) {
        png_set_tRNS_to_alpha(pngPtr);
        channels += 1;
    }

    // we don't support 16 bits precision => down it to 8
    if (bitdepth == 16) {
        png_set_strip_16(pngPtr);
    }

    // allocate data struct
    PNGImageData * data = new PNGImageData();
    if (data == 0) {
        return 0;
    }

    data->imageSize.width = width;
    data->imageSize.height = height;
    data->stride = width * bitdepth * channels / 8;
    int dataSize = height * data->stride;
    data->imageData = new unsigned char[dataSize];
    if (data->imageData == 0) {
        delete data;
        return 0;
    }
    data->imageFormat = gfxASurface::ImageFormatUnknown;
    switch (channels) {
        case 4:
            data->imageFormat = gfxASurface::ImageFormatARGB32;
            break;
        case 3:
            data->imageFormat = gfxASurface::ImageFormatRGB24;
            break;
    }
    return data;
}

}

PNGImageData *
PNGReader::ReadFile(const char *fileName) {
    if (fileName == 0) {
        return 0;
    }

    FILE * f = fopen(fileName, "r");
    if (f == 0) {
        return 0;
    }

    PNGImageData * data = readPNGStream(f);
    fclose(f);

    return data;
}

