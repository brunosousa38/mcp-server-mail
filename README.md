# Serveur MCP Mail (IMAP/SMTP)

Un serveur [MCP](https://modelcontextprotocol.io) qui permet à Claude de lire (IMAP) et d'envoyer (SMTP) des emails depuis n'importe quelle boîte mail classique, en deux variantes au choix : **Netlify** (TypeScript serverless) ou **PHP pur** pour hébergement mutualisé (OVH ou autre).

## Les 6 outils exposés

| Outil | Description | Arguments principaux |
|---|---|---|
| `list_folders` | Liste les dossiers IMAP avec compteurs de messages et de non-lus | — |
| `list_emails` | Liste les derniers emails d'un dossier (plus récent en premier) : uid, expéditeur, sujet, date, lu/non-lu, taille | `folder` (défaut `INBOX`), `limit` (défaut 20, max 100), `offset` |
| `read_email` | Lit un email complet par UID : en-têtes, corps texte décodé, métadonnées des pièces jointes | `folder`, `uid` (requis) |
| `search_emails` | Recherche dans un dossier (critères combinés en ET) | `folder`, `from`, `to`, `subject`, `text`, `since`/`before` (YYYY-MM-DD), `unseen`, `limit` |
| `send_email` | Envoie un email via SMTP, en texte brut et/ou HTML, avec pièces jointes optionnelles ; `in_reply_to` permet de répondre dans un fil existant | `to` (requis), `subject` (requis), `body` et/ou `html` (au moins un requis), `attachments`, `cc`, `bcc`, `in_reply_to` |
| `mark_email` | Marque un email comme lu ou non lu | `folder`, `uid` (requis), `seen` (requis) |

### Envoi HTML et pièces jointes (`send_email`)

- **Corps** : fournissez `body` (texte brut), `html` (HTML), ou les deux. Avec les deux, le message est envoyé en `multipart/alternative` (le client mail choisit la version à afficher). Au moins un des deux est requis.
- **Pièces jointes** : `attachments` est une liste d'objets `{ "filename": "…", "content": "<base64>", "content_type": "…" }`. Le contenu du fichier doit être **encodé en Base64** ; `content_type` est optionnel (défaut `application/octet-stream`). Le message devient alors un `multipart/mixed`.

Exemple d'arguments :

```json
{
  "to": "dest@example.com",
  "subject": "Rapport trimestriel",
  "html": "<p>Bonjour,<br>Veuillez trouver le rapport <strong>ci-joint</strong>.</p>",
  "body": "Bonjour, veuillez trouver le rapport ci-joint.",
  "attachments": [
    { "filename": "rapport.pdf", "content": "JVBERi0xLjQK…", "content_type": "application/pdf" }
  ]
}
```

## Configuration

Les deux variantes se configurent de la même façon : **un fichier de configuration** et/ou **des variables d'environnement** (les variables d'environnement sont prioritaires).

- **Netlify** : copiez `config.sample.json` en `config.json` à la racine (gitignoré) et remplissez-le, ou définissez les variables d'environnement dans l'interface Netlify.
- **PHP / OVH** : copiez `php-ovh/config.sample.php` en `php-ovh/config.local.php` (gitignoré) et remplissez-le.

Générez le token d'authentification (32 caractères minimum) :

```bash
openssl rand -hex 32
```

### Variables d'environnement

| Variable | Description | Défaut |
|---|---|---|
| `MCP_AUTH_TOKEN` | Token d'authentification du serveur MCP (≥ 32 caractères) | — (requis) |
| `IMAP_HOST` | Serveur IMAP | — (requis) |
| `IMAP_PORT` | Port IMAP | `993` |
| `IMAP_USER` | Identifiant IMAP (l'adresse email en général) | — (requis) |
| `IMAP_PASSWORD` | Mot de passe IMAP | — (requis) |
| `IMAP_ENCRYPTION` | `ssl` \| `starttls` \| `none` | `ssl` |
| `SMTP_HOST` | Serveur SMTP | — (requis) |
| `SMTP_PORT` | Port SMTP | `465` |
| `SMTP_USER` | Identifiant SMTP | reprend `IMAP_USER` |
| `SMTP_PASSWORD` | Mot de passe SMTP | reprend `IMAP_PASSWORD` |
| `SMTP_ENCRYPTION` | `ssl` \| `starttls` \| `none` | `ssl` |
| `MAIL_FROM` | Adresse d'expéditeur | reprend `IMAP_USER` |
| `MAIL_FROM_NAME` | Nom d'expéditeur affiché | partie locale de `MAIL_FROM` |

### Exemples de serveurs mail

| Fournisseur | IMAP | SMTP | Remarque |
|---|---|---|---|
| Infomaniak | `mail.infomaniak.com`, port 993, `ssl` | `mail.infomaniak.com`, port 465, `ssl` | |
| OVH | `ssl0.ovh.net`, port 993, `ssl` | `ssl0.ovh.net`, port 465, `ssl` | |
| Gmail | `imap.gmail.com`, port 993, `ssl` | `smtp.gmail.com`, port 465, `ssl` | Nécessite un [mot de passe d'application](https://support.google.com/accounts/answer/185833) |

> ⚠️ **Proton Mail** n'expose pas d'IMAP/SMTP directement : il faut Proton Bridge, qui tourne en local sur votre machine. C'est incompatible avec un déploiement Netlify ou un hébergement mutualisé — ces variantes ne peuvent donc pas se connecter à une boîte Proton.

## Déploiement Netlify (variante TypeScript)

1. **Via l'interface Netlify** (recommandé) : liez ce dépôt à un site Netlify (le build est automatique grâce à `netlify.toml`), puis définissez les variables d'environnement dans *Site settings → Environment variables* (`MCP_AUTH_TOKEN`, `IMAP_*`, `SMTP_*`, `MAIL_FROM`…).
2. **Ou via la CLI** : créez un `config.json` local (copie remplie de `config.sample.json`) puis lancez `netlify deploy --prod`. Le fichier est embarqué dans la fonction grâce à `included_files` dans `netlify.toml`.

L'endpoint MCP est alors : `https://<votre-site>.netlify.app/mcp`

## Déploiement OVH (ou tout mutualisé Apache/PHP ≥ 8.1)

1. Téléversez par FTP le **contenu** du dossier `php-ovh/` (à la racine du site ou dans un sous-dossier, par ex. `/mcp-mail/`).
2. Sur le serveur, copiez `config.sample.php` en `config.local.php` et remplissez-le (token, identifiants IMAP/SMTP).
3. Vérifiez que la version PHP du site est ≥ 8.1 (espace client OVH → *Hébergement → Informations générales → Configuration PHP*).

L'endpoint MCP est : `https://votre-domaine.tld/mcp` (URL réécrite par `.htaccess`), ou `https://votre-domaine.tld/mcp.php` si la réécriture d'URL est inactive. Ajoutez le sous-dossier au besoin.

Les fichiers `.htaccess` fournis protègent `config.local.php` et l'intégralité de `lib/` contre tout accès direct par le web.

## Connexion à Claude

Le serveur accepte le token de deux manières : en-tête `Authorization: Bearer <token>` ou paramètre d'URL `?token=<token>`.

1. **claude.ai et Claude Desktop** — *Paramètres → Connecteurs → Ajouter un connecteur personnalisé*, avec l'URL :

   ```
   https://votre-domaine.tld/mcp?token=VOTRE_TOKEN
   ```

   Les connecteurs personnalisés ne permettent pas d'ajouter d'en-têtes HTTP, d'où le token dans l'URL.

2. **Claude Code** :

   ```bash
   claude mcp add --transport http mail https://votre-domaine.tld/mcp \
     --header "Authorization: Bearer VOTRE_TOKEN"
   ```

3. **Anciens clients MCP (stdio uniquement)** — via le pont `mcp-remote` :

   ```bash
   npx mcp-remote https://votre-domaine.tld/mcp \
     --header "Authorization: Bearer VOTRE_TOKEN"
   ```

## Test manuel

```bash
# Page d'accueil (healthcheck)
curl -s https://votre-domaine.tld/

# Sans token -> 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://votre-domaine.tld/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# Avec token -> réponse initialize
curl -s -X POST https://votre-domaine.tld/mcp \
  -H "Authorization: Bearer VOTRE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

## Sécurité

- **Le token donne un accès complet à la boîte mail** (lecture et envoi). Traitez-le comme un mot de passe.
- **HTTPS obligatoire** : ne déployez jamais l'endpoint en HTTP clair.
- Le token passé en query string (`?token=…`) apparaît dans les logs du serveur web : **préférez l'en-tête `Authorization`** dès que le client le permet, et réservez la query aux connecteurs claude.ai/Desktop qui n'offrent pas d'autre option.
- **Faites tourner le token** régulièrement (régénérez avec `openssl rand -hex 32`, mettez à jour la config et les connecteurs).

## Développement local

```bash
npm install
npm run build        # typecheck de la variante TypeScript
npm run test:smoke   # démarre les fakes IMAP/SMTP + teste les DEUX variantes
```

Le smoke test (`test/smoke.mjs`) démarre un faux serveur IMAP et un faux serveur SMTP (Node pur, sans dépendance), lance la variante PHP avec `php -S` et exerce la variante TypeScript via son handler Netlify, puis vérifie les 6 outils de bout en bout. PHP ≥ 8.1 est requis en local pour la partie PHP.

## Licence

MIT.
