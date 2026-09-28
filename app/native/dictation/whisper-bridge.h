// Bug 165: whisper.cpp's C API, imported into the helper when build.sh finds the static libraries
// in Synapse's own directory. Without them the helper is compiled without -D WHISPER and this
// header is never read.
#include "whisper.h"
