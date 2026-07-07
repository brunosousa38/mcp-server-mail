<?php
/**
 * Configuration du serveur MCP Mail (IMAP/SMTP) — variante PHP pour hébergement mutualisé.
 *
 * 1. Copiez ce fichier en `config.local.php` (dans le même dossier).
 * 2. Remplissez les valeurs ci-dessous.
 * 3. Ne committez JAMAIS config.local.php (il contient vos mots de passe).
 *
 * Chaque valeur peut aussi être surchargée par variable d'environnement :
 * MCP_AUTH_TOKEN, IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASSWORD, IMAP_ENCRYPTION,
 * SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_ENCRYPTION, MAIL_FROM, MAIL_FROM_NAME.
 */
return [
    // Token d'authentification MCP (≥ 32 caractères). Générez-le : openssl rand -hex 32
    'mcp_auth_token' => '',
    'imap' => [
        'host' => 'mail.infomaniak.com', // OVH : ssl0.ovh.net
        'port' => 993,
        'user' => 'votre@adresse.fr',
        'password' => '',
        'encryption' => 'ssl', // ssl | starttls | none
    ],
    'smtp' => [
        'host' => 'mail.infomaniak.com',
        'port' => 465,
        'user' => '',      // vide = reprend imap.user
        'password' => '',  // vide = reprend imap.password
        'encryption' => 'ssl', // ssl | starttls | none
    ],
    'mail_from' => '',      // vide = reprend imap.user
    'mail_from_name' => '', // nom d'expéditeur affiché
];
