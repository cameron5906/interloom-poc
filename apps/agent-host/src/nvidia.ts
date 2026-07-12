import { existsSync } from "fs";

// Docker Desktop / WSL2 injects the driver's nvidia-smi under /usr/lib/wsl/lib,
// which is not always on PATH inside containers.
const CANDIDATES = ["/usr/lib/wsl/lib/nvidia-smi", "/usr/bin/nvidia-smi"];

export const NVIDIA_SMI = CANDIDATES.find((p) => existsSync(p)) ?? "nvidia-smi";
