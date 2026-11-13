#include <stdio.h>
#include <string.h>

// macOS provides atomic no-replace creation and an atomic exchange of directories.
int main(int argc, char **argv) {
    if (argc != 4) return 2;
    unsigned int flags = !strcmp(argv[1], "swap") ? RENAME_SWAP : RENAME_EXCL;
    if (renamex_np(argv[2], argv[3], flags | RENAME_NOFOLLOW_ANY) == -1) {
        perror("renamex_np");
        return 1;
    }
    return 0;
}
