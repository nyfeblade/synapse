# Bug 295: map whisper.cpp's source and build folders away from every compiled __FILE__ and debug path, so the
# helper never carries the builder's absolute path. install.sh passes this as CMAKE_PROJECT_INCLUDE. Each map is one
# list item, so CMake quotes it for the compiler itself: a checkout under a folder with a space still builds
# (CMAKE_C_FLAGS is a plain string that CMake splits on spaces, which broke exactly that).
include_guard(GLOBAL)
add_compile_options(
  "$<$<COMPILE_LANGUAGE:C,CXX,OBJC,OBJCXX>:-ffile-prefix-map=${CMAKE_SOURCE_DIR}=whisper.cpp>"
  "$<$<COMPILE_LANGUAGE:C,CXX,OBJC,OBJCXX>:-ffile-prefix-map=${CMAKE_BINARY_DIR}=whisper-build>"
)
