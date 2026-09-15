class Repo {
  /**
   * Initialise le dépôt GitHub.
   * @param {Object} config - Configuration du dépôt.
   * @param {string} config.owner - Propriétaire du dépôt.
   * @param {string} config.repo - Nom du dépôt.
   * @param {string} config.pat - Personal Access Token (PAT).
   * @param {string} [config.branch='main'] - Branche visée (par défaut 'main').
   */
  constructor({ owner, repo, pat, branch = 'main' }) {
    this.owner = owner;
    this.repo = repo;
    this.pat = pat;
    this.branch = branch;
    this.baseUrl = `https://api.github.com/repos/${owner}/${repo}/contents`;
  }

  // En-têtes HTTP réutilisables pour les requêtes GitHub
  _getHeaders() {
    return {
      'Authorization': `Bearer ${this.pat}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    };
  }

  // Encodage Base64 compatible UTF-8 (navigateur et Node.js)
  _toBase64(str) {
    if (typeof btoa === 'function') {
      return btoa(unescape(encodeURIComponent(str)));
    }
    return Buffer.from(str, 'utf-8').toString('base64');
  }

  // Décodage Base64 compatible UTF-8
  _fromBase64(str) {
    if (typeof atob === 'function') {
      return decodeURIComponent(escape(atob(str.replace(/\n/g, ''))));
    }
    return Buffer.from(str, 'base64').toString('utf-8');
  }

  /**
   * Récupère et lit un fichier depuis le dépôt.
   * @param {string} path - Chemin du fichier.
   * @returns {Promise<Object|string>} Contenu parsé (si JSON) ou texte brut.
   */
  async pull(path) {
    const url = `${this.baseUrl}/${encodeURIComponent(path)}?ref=${this.branch}`;
    const response = await fetch(url, { headers: this._getHeaders() });

    if (!response.ok) {
      throw new Error(`Échec du pull [${response.status}]: ${response.statusText}`);
    }

    const data = await response.json();
    const rawContent = this._fromBase64(data.content);

    try {
      return JSON.parse(rawContent);
    } catch {
      return rawContent;
    }
  }

  /**
   * Crée ou met à jour un ou plusieurs fichiers.
   * @param {Object} payload - Données du push.
   * @param {Array<{path: string, content: any}>} payload.files - Fichiers à envoyer.
   * @param {string} payload.message - Message de commit.
   * @returns {Promise<Array<Object>>} Réponses de l'API GitHub.
   */
  async push({ files, message }) {
    const results = [];

    for (const file of files) {
      const { path, content } = file;
      const url = `${this.baseUrl}/${encodeURIComponent(path)}`;

      // Recherche du SHA si le fichier existe déjà
      let sha;
      try {
        const getRes = await fetch(`${url}?ref=${this.branch}`, { headers: this._getHeaders() });
        if (getRes.ok) {
          const getData = await getRes.json();
          sha = getData.sha;
        }
      } catch {
        // Le fichier n'existe pas encore
      }

      const stringContent = typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content);

      const body = {
        message: message,
        content: this._toBase64(stringContent),
        branch: this.branch,
        ...(sha && { sha })
      };

      const response = await fetch(url, {
        method: 'PUT',
        headers: this._getHeaders(),
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw new Error(`Échec du push pour ${path} [${response.status}]: ${response.statusText}`);
      }

      results.push(await response.json());
    }

    return results;
  }

  /**
   * Liste les fichiers et dossiers dans un répertoire.
   * @param {string} [path=''] - Chemin du répertoire.
   * @returns {Promise<Array<Object>>} Liste des éléments.
   */
  async list(path = '') {
    const cleanPath = path.replace(/\/$/, '');
    const url = `${this.baseUrl}/${encodeURIComponent(cleanPath)}?ref=${this.branch}`;
    
    const response = await fetch(url, { headers: this._getHeaders() });

    if (!response.ok) {
      throw new Error(`Échec du list [${response.status}]: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Supprime un fichier du dépôt.
   * @param {string} path - Chemin du fichier à supprimer.
   * @param {string} [message='Suppression de fichier'] - Message du commit.
   * @returns {Promise<Object>} Réponse de l'API GitHub.
   */
  async delete(path, message = 'Suppression de fichier') {
    const url = `${this.baseUrl}/${encodeURIComponent(path)}`;

    // Récupération obligatoire du SHA avant suppression
    const getRes = await fetch(`${url}?ref=${this.branch}`, { headers: this._getHeaders() });
    if (!getRes.ok) {
      throw new Error(`Impossible de trouver le fichier à supprimer : ${path}`);
    }
    const getData = await getRes.json();

    const body = {
      message: message,
      sha: getData.sha,
      branch: this.branch
    };

    const response = await fetch(url, {
      method: 'DELETE',
      headers: this._getHeaders(),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Échec de la suppression [${response.status}]: ${response.statusText}`);
    }

    return await response.json();
  }
}