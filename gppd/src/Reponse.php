<?php

class Response
{
    public static function json(
        mixed $data,
        int $status = 200
    ): never {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('X-Content-Type-Options: nosniff');

        echo json_encode(
            $data,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        );

        exit;
    }

    public static function error(
        string $message,
        int $status = 400
    ): never {
        self::json([
            'success' => false,
            'error' => $message,
        ], $status);
    }

    public static function success(
        mixed $data = null,
        int $status = 200
    ): never {
        self::json([
            'success' => true,
            'data' => $data,
        ], $status);
    }

    public static function file(
        string $path,
        string $name,
        string $mime,
        bool $preview = false
    ): never {
        if (!is_file($path)) {
            self::error('Fichier introuvable', 404);
        }

        $inlineTypes = [
            'application/pdf',
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/webp',
            'text/plain',
        ];

        $inline = $preview && in_array($mime, $inlineTypes, true);

        header('Content-Type: ' . ($inline ? $mime : 'application/octet-stream'));
        header('Content-Length: ' . filesize($path));
        header('Content-Disposition: ' .
            ($inline ? 'inline' : 'attachment') .
            '; filename="' . addcslashes(basename($name), '"\\') . '"'
        );
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, no-store');

        readfile($path);
        exit;
    }
}
