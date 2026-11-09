<?php

declare(strict_types=1);

$config = require dirname(__DIR__) . '/config/config.php';

require dirname(__DIR__) . '/database/Database.php';
require dirname(__DIR__) . '/src/Response.php';
require dirname(__DIR__) . '/src/Auth.php';
require dirname(__DIR__) . '/src/Storage.php';
require dirname(__DIR__) . '/src/Api.php';

if ($config['cors']['enabled']) {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';

    if (
        in_array('*', $config['cors']['origins'], true) ||
        in_array($origin, $config['cors']['origins'], true)
    ) {
        header('Access-Control-Allow-Origin: ' .
            (in_array('*', $config['cors']['origins'], true) ? '*' : $origin));
    }
}

try {
    (new Api($config))->run();
} catch (Throwable $e) {
    error_log((string)$e);

    Response::error(
        $config['debug'] ? $e->getMessage() : 'Erreur interne',
        500
    );
}
