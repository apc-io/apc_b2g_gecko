/*
 * some copy right message
 * \author Nguyen Thanh Trung <nguyenthanh.trung@nomovok.vn>
 */

#ifndef PNG_READER_H
#define PNG_READER_H

#include "gfxASurface.h"
#include <png.h>
#include <istream>
#include <cstdio>

struct PNGImageData {
public:
    PNGImageData();

    void Dispose();

public:
    unsigned char * imageData;
    gfxIntSize imageSize;
    long stride;
    gfxASurface::gfxImageFormat imageFormat;
};

class PNGReader {
public:
    PNGImageData * ReadFile(const char *fileName);
};

#endif // PNG_READER_H

