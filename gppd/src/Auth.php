<?php

class Auth
{
    private string $user;
    private bool $admin;

    public function __construct(array $config)
    {
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';

        if (!preg_match('/^Bearer\s+(.+)$/i', $header, $matches)) {
            Response::error('Authentification requise', 401);
        }

        $token = trim($matches[1]);
        $keys = $config['api_keys'];

        if (!isset($keys[$token])) {
            Response::error('Token invalide', 401);
        }

        $this->user = $keys[$token];
        $this->admin = in_array($this->user, $config['admin_users'], true);
    }

    public function user(): string
    {
        return $this->user;
    }

    public function isAdmin(): bool
    {
        return $this->admin;
    }
}
