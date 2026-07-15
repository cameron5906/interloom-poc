export type {
  WebSocketLike,
  WsConstructorLike,
  CryptoLike,
  RtcDataChannelLike,
  RtcPeerConnectionLike,
  RtcAdapter,
} from "./adapters.js";
export { WS_OPEN } from "./adapters.js";

export {
  generateLinkSecret,
  encodeSecret,
  decodeSecret,
  buildLinkUrl,
  parseLinkFragment,
  parseLinkUrl,
  generateEcdhKeyPair,
  deriveLinkKeyV2,
  encryptLinkPayload,
  decryptLinkPayload,
  type ParsedLinkUrl,
  type EncryptedBlob,
} from "./crypto.js";

export {
  LinkSession,
  createIssuer,
  createScanner,
  DEFAULT_STUN_URLS,
  type LinkStage,
  type LinkCandidate,
  type LinkSessionCallbacks,
  type LinkSessionOptions,
  type IssuerSessionOptions,
  type ScannerSessionOptions,
} from "./session.js";
