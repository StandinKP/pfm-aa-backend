import base64, json, sys
from cryptography.hazmat.primitives import hpke
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, PrivateFormat, NoEncryption
k = X25519PrivateKey.generate()
suite = hpke.Suite(hpke.KEM.X25519, hpke.KDF.HKDF_SHA256, hpke.AEAD.CHACHA20_POLY1305)
info=b"airlock.reply.v1|abc|sha256:def"
msg = suite.encrypt(b'{"hello":"world"}', k.public_key(), info=info)
print(json.dumps({"pem": k.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode(), "blob": base64.b64encode(msg).decode(), "info": info.decode()}))
