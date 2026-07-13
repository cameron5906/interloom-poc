export const PORT = Number(process.env["PORT"] ?? 7420);
export const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
export const MODELS_DIR = process.env["MODELS_DIR"] ?? "./models";
export const NETWORK_URL = process.env["NETWORK_URL"] ?? "https://interloom-net.tryeris.com";
export const INFERENCE_URL = process.env["INFERENCE_URL"] ?? "http://inference:8080";
export const FETCHER_URL = process.env["FETCHER_URL"] ?? "http://model-fetcher:7423";
export const UPDATER_URL = process.env["UPDATER_URL"] ?? "http://updater:7424";
export const HOST_VERSION = process.env["HOST_VERSION"] ?? "dev";
