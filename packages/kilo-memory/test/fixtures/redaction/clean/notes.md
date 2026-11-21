# Configuration notes

Set `API_KEY` in the environment before starting. The variable name is public; the value is not
part of this document.

```bash
export API_KEY=<your-key>
curl -H "Authorization: Bearer <token>" https://example.test/health
```

- `token_type` selects the scheme and stays `Bearer`.
- `secret_name` points at the vault entry, not at the secret.
- `api_key_env` names the variable that holds the key.
- Clone with `ssh://git@github.com/example/repo.git`.

The checksum is a plain digest, not a credential:
`9f2c7a1b4d8e0f3a6b5c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a`.
