import base64
import hashlib
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def encryption_key(encoded: str) -> bytes:
    key = base64.b64decode(encoded, validate=True)
    if len(key) != 32:
        raise ValueError("POCKET_SECRET_KEY must decode to 32 bytes")
    return key


def encrypt_secret(encoded_key: str, plaintext: str) -> str:
    nonce = secrets.token_bytes(12)
    encrypted = AESGCM(encryption_key(encoded_key)).encrypt(
        nonce, plaintext.encode(), None
    )
    return base64.b64encode(nonce + encrypted).decode()


def decrypt_secret(encoded_key: str, ciphertext: str) -> str:
    raw = base64.b64decode(ciphertext, validate=True)
    plaintext = AESGCM(encryption_key(encoded_key)).decrypt(
        raw[:12], raw[12:], None
    )
    return plaintext.decode()
