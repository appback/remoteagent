# CLI bootstrap and secret migration

## First Telegram bot

Install RemoteAgent, seed its runtime configuration, and register the first Telegram bot:

```bash
npm install -g appback-remoteagent
remoteagent-install
remoteagent bot add
remoteagent-start
```

`remoteagent bot add` asks for the BotFather token without echoing it and then asks for the numeric Telegram owner user ID. It validates the token with Telegram `getMe` before writing `~/.remoteagent/.env`.

For automation, keep sensitive values out of shell history by using a permission-restricted token file:

```bash
chmod 600 /secure/path/telegram-token
remoteagent bot add --token-file /secure/path/telegram-token --owner 123456789
```

After adding or updating a bot, apply the configuration with the runtime command appropriate to the installation:

```bash
remoteagent-start
```

```bash
sudo systemctl restart remoteagent
```

## Secret migration

RemoteAgent `/secret` values belong to the installation, not to an individual agent session. They are stored under `~/.remoteagent/managed/secrets.json`.

Export them on the old PC as a password-encrypted bundle:

```bash
remoteagent secret export ~/remoteagent-secrets.ra-secrets
```

The command asks twice for a bundle passphrase. The resulting file uses scrypt key derivation and AES-256-GCM authenticated encryption; secret values are never printed.

Transfer the encrypted file to the new PC, install RemoteAgent, and import it:

```bash
remoteagent-install
remoteagent secret import ~/remoteagent-secrets.ra-secrets
```

Import merges the bundle into the new PC's installation-wide Secret store. Imported keys replace keys with the same name; unrelated existing keys remain. Before overwriting an existing store, RemoteAgent creates a permission-restricted timestamped backup beside `secrets.json`.

Use `--replace` only when the imported bundle must become the entire Secret store:

```bash
remoteagent secret import ~/remoteagent-secrets.ra-secrets --replace
```

For non-interactive automation, provide a permission-restricted passphrase file:

```bash
chmod 600 /secure/path/transfer-passphrase
remoteagent secret export ~/remoteagent-secrets.ra-secrets --passphrase-file /secure/path/transfer-passphrase
remoteagent secret import ~/remoteagent-secrets.ra-secrets --passphrase-file /secure/path/transfer-passphrase
```

The Telegram bot token and `TELEGRAM_OWNER_ID` are runtime configuration, not `/secret` values. Register the bot separately with `remoteagent bot add` on the new PC.
