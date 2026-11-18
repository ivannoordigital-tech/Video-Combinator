import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Test integrasi menjalankan FFmpeg/FFprobe dan menulis ke cache sementara.
    // Beri ruang lebih dari default 5 detik dan jalankan file secara berurutan
    // agar tidak saling berebut CPU/disk.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
