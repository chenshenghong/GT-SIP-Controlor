/* mzsdk.c */
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include "mzsdk.h"

#ifndef MZSDK_PATH
#define MZSDK_PATH "/tmp/sip.sdk"
#endif

int mzsdk_send(const char* cmd)
{
    int fd = socket(PF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, MZSDK_PATH, sizeof(addr.sun_path) - 1);
    connect(fd, (struct sockaddr*)&addr, sizeof(addr));

    struct pollfd pfd = { .fd = fd, .events = POLLOUT | POLLERR | POLLNVAL };
    if (poll(&pfd, 1, 1000) <= 0 || !(pfd.revents & POLLOUT)) { close(fd); return -1; }
    int len = (int)strlen(cmd);
    if (send(fd, cmd, len, MSG_NOSIGNAL) != len) { close(fd); return -1; }

    struct pollfd rpfd = { .fd = fd, .events = POLLIN | POLLERR | POLLNVAL };
    if (poll(&rpfd, 1, 1000) <= 0 || !(rpfd.revents & POLLIN)) { close(fd); return -1; }
    char reply[128];
    int n = (int)read(fd, reply, sizeof(reply));
    close(fd);
    return n > 4 ? 0 : -1;
}
