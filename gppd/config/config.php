<?php

return [
    'database' => [
        'driver' => 'sqlite', // sqlite ou mysql
        'sqlite_path' => dirname(__DIR__) . '/storage/filesystem.sqlite',
        'mysql_host' => '127.0.0.1',
        'mysql_port' => 3306,
        'mysql_name' => 'filesystem',
        'mysql_user' => 'root',
        'mysql_password' => '',
    ],

    'storage_path' => dirname(__DIR__) . '/storage/files',
    'thumbnail_path' => dirname(__DIR__) . '/storage/thumbnails',

    // Token => identifiant utilisateur
    'api_keys' => [
        'CHANGE_ME_ADMIN_TOKEN' => 'admin',
    ],

    'admin_users' => ['admin'],

    'max_upload_size' => 100 * 1024 * 1024,

    // Tableau vide = tous les types MIME acceptés
    'allowed_mime_types' => [],

    'cors' => [
        'enabled' => false,
        'origins' => ['*'],
    ],

    'debug' => false,
];
