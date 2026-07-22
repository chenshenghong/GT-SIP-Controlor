#include <fcntl.h>
#include <unistd.h>
#include "socketbase.h"
void set_no_block(int fd) { int f = fcntl(fd, F_GETFL, 0); if (f >= 0) fcntl(fd, F_SETFL, f | O_NONBLOCK); }
void close_socket(int fd) { if (fd >= 0) close(fd); }
