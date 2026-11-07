#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc_info.h>
#include <time.h>
#include <unistd.h>

struct process_identity {
  pid_t pid;
  uint32_t parent;
  char started[36];
};

static void unavailable(const char *reason) {
  printf("{\"version\":1,\"status\":\"unavailable\",\"reason\":\"%s\"}\n", reason);
}

static bool disappeared(pid_t pid) {
  return kill(pid, 0) == -1 && errno == ESRCH;
}

int main(void) {
  const uid_t user = getuid();
  const int maximum = 1024 * 1024;
  errno = 0;
  int estimated = proc_listpids(PROC_UID_ONLY, user, NULL, 0);
  if (estimated <= 0) {
    unavailable(errno ? "enumeration-denied" : "empty");
    return 0;
  }
  if (estimated > maximum - 256 * (int)sizeof(pid_t)) {
    unavailable("truncated");
    return 0;
  }
  int capacity = estimated + 256 * (int)sizeof(pid_t);
  pid_t *pids = malloc((size_t)capacity);
  if (pids == NULL) return 1;
  errno = 0;
  int bytes = proc_listpids(PROC_UID_ONLY, user, pids, capacity);
  const char *reason = NULL;
  if (bytes <= 0) reason = errno ? "enumeration-denied" : "empty";
  else if (bytes >= capacity || bytes % (int)sizeof(pid_t)) reason = "truncated";
  if (reason != NULL) {
    free(pids);
    unavailable(reason);
    return 0;
  }
  const size_t count = (size_t)bytes / sizeof(pid_t);
  struct process_identity *identities = calloc(count, sizeof(*identities));
  if (identities == NULL) {
    free(pids);
    return 1;
  }
  size_t collected = 0;
  for (size_t index = 0; index < count; index++) {
    const pid_t pid = pids[index];
    if (pid <= 0) {
      reason = "invalid-identity";
      break;
    }
    struct proc_bsdinfo info = {0};
    errno = 0;
    int received = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (received != (int)sizeof(info)) {
      if ((errno == ESRCH || errno == ENOENT || errno == 0) && disappeared(pid)) continue;
      reason = "identity-unavailable";
      break;
    }
    if (info.pbi_pid != (uint32_t)pid || info.pbi_uid != user || info.pbi_start_tvsec == 0) {
      reason = "invalid-identity";
      break;
    }
    struct tm started;
    time_t seconds = (time_t)info.pbi_start_tvsec;
    struct process_identity *item = &identities[collected];
    if (localtime_r(&seconds, &started) == NULL ||
        !strftime(item->started, sizeof(item->started), "%a %b %e %H:%M:%S %Y", &started)) {
      reason = "invalid-identity";
      break;
    }
    item->pid = pid;
    item->parent = info.pbi_ppid;
    collected++;
  }
  if (reason != NULL || collected == 0) {
    unavailable(reason != NULL ? reason : "empty");
  } else {
    printf("{\"version\":1,\"status\":\"complete\",\"processes\":[");
    for (size_t index = 0; index < collected; index++) {
      const struct process_identity *item = &identities[index];
      printf("%s{\"pid\":%d,\"parentPid\":%u,\"startedAt\":\"%s\"}",
             index ? "," : "", item->pid, item->parent, item->started);
    }
    puts("]}");
  }
  free(identities);
  free(pids);
  return ferror(stdout) ? 1 : 0;
}
