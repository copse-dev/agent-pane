// Read only the requested processes. Unlike RSS, ri_phys_footprint includes
// memory compressed/swapped by macOS and matches its application accounting.
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    char *end = NULL;
    errno = 0;
    long value = strtol(argv[i], &end, 10);
    if (errno || end == argv[i] || *end != '\0' || value <= 0 || value > INT_MAX) {
      return 2;
    }
    struct rusage_info_v4 info = {0};
    // A process can exit or become inaccessible between enumeration and this
    // call. Omit it so the caller reports unknown, never a misleading zero.
    if (proc_pid_rusage((pid_t)value, RUSAGE_INFO_V4, (rusage_info_t *)&info) == 0) {
      printf("%ld %" PRIu64 "\n", value, info.ri_phys_footprint);
    }
  }
  return 0;
}
