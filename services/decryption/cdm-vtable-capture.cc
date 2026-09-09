#include <cstdint>
#include <dlfcn.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <mutex>
#include <vector>

namespace cdm {
enum Status : uint32_t {
    kSuccess = 0,
    kNeedMoreData,
    kNoKey,
    kInitializationError,
    kDecryptError,
    kDecodeError,
    kDeferredInitialization,
};

struct InputBuffer_2;

class Buffer {
public:
    virtual void Destroy() = 0;
    virtual uint32_t Capacity() const = 0;
    virtual uint8_t* Data() = 0;
    virtual void SetSize(uint32_t size) = 0;
    virtual uint32_t Size() const = 0;
protected:
    virtual ~Buffer() = default;
};

class DecryptedBlock {
public:
    virtual void SetDecryptedBuffer(Buffer* buffer) = 0;
    virtual Buffer* DecryptedBuffer() = 0;
    virtual void SetTimestamp(int64_t timestamp) = 0;
    virtual int64_t Timestamp() const = 0;
protected:
    virtual ~DecryptedBlock() = default;
};
}

using DecryptFunction = cdm::Status (*)(void*, const cdm::InputBuffer_2&, cdm::DecryptedBlock*);

struct HookedObject { void* object; DecryptFunction decrypt; };
static std::mutex state_mutex;
static std::vector<HookedObject> hooked;
static pid_t scanner_pid;

static void log_event(const char* value) {
    int output = open("/tmp/sc-vtable-capture.log", O_CREAT | O_WRONLY | O_APPEND, 0600);
    if (output < 0) return;
    write(output, value, strlen(value));
    write(output, "\n", 1);
    close(output);
}

static void save_aac(cdm::DecryptedBlock* block) {
    cdm::Buffer* buffer = block->DecryptedBuffer();
    if (!buffer || !buffer->Size()) return;
    const char* capture_path = getenv("SC_CAPTURE_PATH");
    if (!capture_path) return;
    std::lock_guard<std::mutex> lock(state_mutex);
    int output = open(capture_path, O_CREAT | O_WRONLY | O_APPEND, 0600);
    if (output < 0) return;
    write(output, buffer->Data(), buffer->Size());
    close(output);
}

static cdm::Status decrypt_hook(void* object, const cdm::InputBuffer_2& input, cdm::DecryptedBlock* output) {
    DecryptFunction original = nullptr;
    {
        std::lock_guard<std::mutex> lock(state_mutex);
        for (const HookedObject& entry : hooked) if (entry.object == object) original = entry.decrypt;
    }
    if (!original) return cdm::kDecryptError;
    cdm::Status status = original(object, input, output);
    if (status == cdm::kSuccess) save_aac(output);
    return status;
}

static void patch_object(int memory, uintptr_t object, uintptr_t vtable) {
    std::lock_guard<std::mutex> lock(state_mutex);
    for (const HookedObject& entry : hooked) if (entry.object == reinterpret_cast<void*>(object)) return;
    void** replacement = static_cast<void**>(mmap(nullptr, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0));
    if (replacement == MAP_FAILED) return;
    if (pread(memory, replacement, 22 * sizeof(void*), vtable) != 22 * sizeof(void*)) return;
    DecryptFunction original = reinterpret_cast<DecryptFunction>(replacement[9]);
    replacement[9] = reinterpret_cast<void*>(decrypt_hook);
    uintptr_t replacement_address = reinterpret_cast<uintptr_t>(replacement);
    if (pwrite(memory, &replacement_address, sizeof(replacement_address), object) != sizeof(replacement_address)) return;
    hooked.push_back({reinterpret_cast<void*>(object), original});
    log_event("patched CDM object");
}

static void* scanner(void*) {
    const uintptr_t vtable_offsets[] = {0x14911a0, 0x1491260};
    for (int attempt = 0; attempt < 2000; attempt++) {
        FILE* maps = fopen("/proc/self/maps", "r");
        int memory = open("/proc/self/mem", O_RDWR);
        if (!maps || memory < 0) return nullptr;
        char line[1024];
        uintptr_t base = 0;
        struct Region { uintptr_t start; uintptr_t end; };
        std::vector<Region> regions;
        while (fgets(line, sizeof(line), maps)) {
            unsigned long start, end, offset;
            char permissions[5];
            if (sscanf(line, "%lx-%lx %4s %lx", &start, &end, permissions, &offset) != 4) continue;
            if (strstr(line, "libwidevinecdm.so") && offset == 0) base = start;
            if (permissions[0] == 'r' && permissions[1] == 'w' && end - start <= 128UL * 1024 * 1024) regions.push_back({start, end});
        }
        fclose(maps);
        if (base) {
            for (const Region& region : regions) {
                size_t size = region.end - region.start;
                std::vector<uintptr_t> values(size / sizeof(uintptr_t));
                ssize_t bytes = pread(memory, values.data(), values.size() * sizeof(uintptr_t), region.start);
                if (bytes <= 0) continue;
                size_t count = bytes / sizeof(uintptr_t);
                for (size_t index = 0; index < count; index++) {
                    for (uintptr_t offset : vtable_offsets) if (values[index] == base + offset) patch_object(memory, region.start + index * sizeof(uintptr_t), values[index]);
                }
            }
        }
        close(memory);
        usleep(10000);
    }
    return nullptr;
}

static void maybe_start_scanner() {
    pid_t pid = getpid();
    if (scanner_pid == pid) return;
    char command[4096] = {};
    int input = open("/proc/self/cmdline", O_RDONLY);
    if (input < 0) return;
    ssize_t size = read(input, command, sizeof(command) - 1);
    close(input);
    if (size <= 0) return;
    for (ssize_t index = 0; index < size; index++) if (!command[index]) command[index] = ' ';
    if (!strstr(command, "media.mojom.CdmServiceBroker")) return;
    scanner_pid = pid;
    pthread_t thread;
    pthread_create(&thread, nullptr, scanner, nullptr);
    pthread_detach(thread);
    log_event("started CDM scanner");
}

extern "C" int prctl(int option, ...) {
    va_list arguments;
    va_start(arguments, option);
    unsigned long second = va_arg(arguments, unsigned long);
    unsigned long third = va_arg(arguments, unsigned long);
    unsigned long fourth = va_arg(arguments, unsigned long);
    unsigned long fifth = va_arg(arguments, unsigned long);
    va_end(arguments);
    int result = syscall(SYS_prctl, option, second, third, fourth, fifth);
    maybe_start_scanner();
    return result;
}

extern "C" void* dlopen(const char* filename, int flags) {
    using DlopenFunction = void* (*)(const char*, int);
    static DlopenFunction original = reinterpret_cast<DlopenFunction>(dlvsym(RTLD_NEXT, "dlopen", "GLIBC_2.2.5"));
    void* handle = original(filename, flags);
    if (filename && strstr(filename, "libwidevinecdm.so")) maybe_start_scanner();
    return handle;
}
