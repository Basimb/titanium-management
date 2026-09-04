import {
  constants,
  createDecipheriv,
  createHash,
  createPublicKey,
  privateDecrypt,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [base64BackupPath, privateKeyPath, outputArchivePath] = process.argv.slice(2);
if (![base64BackupPath, privateKeyPath, outputArchivePath].every(Boolean)) {
  throw new Error("Usage: node decrypt-titanium-backup.mjs <backup.enc.b64> <private-key.pem> <output.tar.gz>");
}

const rawEncoded = readFileSync(base64BackupPath, "ascii");
const encoded = rawEncoded.trim();
if (rawEncoded !== encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
  throw new Error("The backup is not valid base64");
}
const encrypted = Buffer.from(encoded, "base64");
const maximumBackupBytes = 512 * 1024 * 1024;
if (encrypted.length > maximumBackupBytes) {
  throw new Error("The encrypted backup exceeds the supported size limit");
}

const magic = Buffer.from("TITBKUP\0", "ascii");
const fixedHeaderLength = 60;
if (encrypted.length <= fixedHeaderLength || !encrypted.subarray(0, magic.length).equals(magic)) {
  throw new Error("Unsupported or damaged Titanium backup header");
}

let offset = magic.length;
const version = encrypted.readUInt8(offset++);
const wrapAlgorithm = encrypted.readUInt8(offset++);
const aeadAlgorithm = encrypted.readUInt8(offset++);
const payloadFormat = encrypted.readUInt8(offset++);
if (version !== 1 || wrapAlgorithm !== 1 || aeadAlgorithm !== 1 || payloadFormat !== 1) {
  throw new Error("Unsupported Titanium backup algorithms or version");
}
const headerLength = encrypted.readUInt32BE(offset);
offset += 4;
const wrappedLength = encrypted.readUInt16BE(offset);
offset += 2;
const nonceLength = encrypted.readUInt8(offset++);
const tagLength = encrypted.readUInt8(offset++);
const ciphertextLengthBig = encrypted.readBigUInt64BE(offset);
offset += 8;
const storedKeyId = encrypted.subarray(offset, offset + 32);
offset += 32;
if (wrappedLength !== 512 || nonceLength !== 12 || tagLength !== 16) {
  throw new Error("Invalid Titanium backup parameter lengths");
}
if (headerLength !== fixedHeaderLength + wrappedLength + nonceLength) {
  throw new Error("Invalid Titanium backup header length");
}
if (ciphertextLengthBig > BigInt(Number.MAX_SAFE_INTEGER) || ciphertextLengthBig > BigInt(maximumBackupBytes)) {
  throw new Error("Invalid Titanium backup payload length");
}
const ciphertextLength = Number(ciphertextLengthBig);
if (encrypted.length !== headerLength + ciphertextLength + tagLength) {
  throw new Error("The Titanium backup is truncated or has trailing data");
}

const wrappedKey = encrypted.subarray(offset, offset + wrappedLength);
offset += wrappedLength;
const iv = encrypted.subarray(offset, offset + nonceLength);
offset += nonceLength;
const authenticatedHeader = encrypted.subarray(0, headerLength);
const ciphertext = encrypted.subarray(headerLength, headerLength + ciphertextLength);
const tag = encrypted.subarray(headerLength + ciphertextLength);

const privateKey = readFileSync(privateKeyPath, "utf8");
const publicKeyDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
const calculatedKeyId = createHash("sha256").update(publicKeyDer).digest();
if (!timingSafeEqual(storedKeyId, calculatedKeyId)) {
  throw new Error("The selected private key does not match this backup");
}
const aesKey = privateDecrypt(
  {
    key: privateKey,
    oaepHash: "sha256",
    padding: constants.RSA_PKCS1_OAEP_PADDING,
  },
  wrappedKey,
);
if (aesKey.length !== 32) {
  throw new Error("Invalid decrypted AES key length");
}

const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
decipher.setAAD(authenticatedHeader, { plaintextLength: ciphertext.length });
decipher.setAuthTag(tag);
const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
writeFileSync(outputArchivePath, plaintext, { mode: 0o600, flag: "wx" });
process.stdout.write(`Restored ${plaintext.length} bytes to ${outputArchivePath}\n`);

