const API = '/api';
let token = '';
let currentFolder = null;
let folders = [{id:null, name:'Racine'}];

const $ = id => document.getElementById(id);

async function request(path, method = 'GET', body = null) {
    const options = {
        method,
        headers: {'Authorization': 'Bearer ' + token}
    };

    if (body instanceof FormData) {
        options.body = body;
    } else if (body !== null) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    const response = await fetch(API + path, options);

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'Erreur HTTP ' + response.status);
    }

    if (response.status === 204) return null;

    return response.json();
}

function status(message) {
    $('status').textContent = message;
}

function updateBreadcrumb() {
    $('breadcrumb').replaceChildren();

    folders.forEach((folder, index) => {
        const button = document.createElement('button');
        button.textContent = folder.name;
        button.onclick = () => {
            folders = folders.slice(0, index + 1);
            currentFolder = folder.id;
            loadFiles();
            updateBreadcrumb();
        };

        $('breadcrumb').append(button);
        if (index < folders.length - 1) {
            $('breadcrumb').append(document.createTextNode(' / '));
        }
    });
}

async function loadFiles() {
    try {
        const query = currentFolder
            ? '?parent_id=' + encodeURIComponent(currentFolder)
            : '';

        const result = await request('/files' + query);
        const container = $('files');
        container.replaceChildren();

        result.data.forEach(file => {
            const item = document.createElement('article');
            item.className = 'file';

            const icon = document.createElement('span');
            icon.textContent = file.is_directory ? '📁' : '📄';

            const name = document.createElement('span');
            name.textContent = file.name;

            const actions = document.createElement('div');

            if (file.is_directory) {
                const open = document.createElement('button');
                open.textContent = 'Ouvrir';
                open.onclick = () => {
                    currentFolder = file.id;
                    folders.push({id:file.id,name:file.name});
                    updateBreadcrumb();
                    loadFiles();
                };
                actions.append(open);
            } else {
                const preview = document.createElement('button');
                preview.textContent = 'Voir';
                preview.onclick = () => showPreview(file);
                actions.append(preview);

                const download = document.createElement('button');
                download.textContent = 'Télécharger';
                download.onclick = () => downloadFile(file);
                actions.append(download);
            }

            const rename = document.createElement('button');
            rename.textContent = 'Renommer';
            rename.onclick = () => renameFile(file);
            actions.append(rename);

            const remove = document.createElement('button');
            remove.textContent = 'Supprimer';
            remove.onclick = () => deleteFile(file);
            actions.append(remove);

            item.append(icon, name, actions);
            container.append(item);
        });

        status(result.data.length + ' élément(s)');
    } catch (e) {
        status(e.message);
    }
}

async function showPreview(file) {
    try {
        const response = await fetch(
            API + '/files/' + file.id + '/preview',
            {headers:{Authorization:'Bearer ' + token}}
        );

        if (!response.ok) throw new Error('Prévisualisation impossible');

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const content = $('preview-content');
        content.replaceChildren();

        if (blob.type.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = url;
            content.append(img);
        } else if (blob.type === 'application/pdf' ||
                   blob.type.startsWith('text/')) {
            const frame = document.createElement('iframe');
            frame.src = url;
            content.append(frame);
        } else {
            URL.revokeObjectURL(url);
            throw new Error('Type non prévisualisable');
        }

        $('preview').showModal();
        $('preview').dataset.url = url;
    } catch (e) {
        status(e.message);
    }
}

async function downloadFile(file) {
    const response = await fetch(
        API + '/files/' + file.id + '/download',
        {headers:{Authorization:'Bearer ' + token}}
    );

    if (!response.ok) {
        status('Téléchargement impossible');
        return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = file.name;
    link.click();

    URL.revokeObjectURL(url);
}

async function uploadFiles(files) {
    for (const file of files) {
        const data = new FormData();
        data.append('file', file);

        if (currentFolder) data.append('parent_id', currentFolder);

        try {
            await request('/files', 'POST', data);
        } catch (e) {
            status(file.name + ' : ' + e.message);
        }
    }

    loadFiles();
}

async function renameFile(file) {
    const name = prompt('Nouveau nom', file.name);
    if (!name) return;

    try {
        const endpoint = file.is_directory
            ? '/directories/' + file.id
            : '/files/' + file.id;

        await request(endpoint, 'PUT', {name});
        loadFiles();
    } catch (e) {
        status(e.message);
    }
}

async function deleteFile(file) {
    if (!confirm('Supprimer ' + file.name + ' ?')) return;

    try {
        const endpoint = file.is_directory
            ? '/directories/' + file.id
            : '/files/' + file.id;

        await request(endpoint, 'DELETE');
        loadFiles();
    } catch (e) {
        status(e.message);
    }
}

$('connect').onclick = () => {
    token = $('token').value.trim();
    if (!token) return;
    currentFolder = null;
    folders = [{id:null,name:'Racine'}];
    updateBreadcrumb();
    loadFiles();
};

$('refresh').onclick = loadFiles;

$('new-folder').onclick = async () => {
    const name = prompt('Nom du dossier');
    if (!name) return;

    try {
        await request('/directories', 'POST', {
            name,
            parent_id: currentFolder
        });
        loadFiles();
    } catch (e) {
        status(e.message);
    }
};

$('upload').onchange = e => uploadFiles(e.target.files);

$('dropzone').onclick = () => $('upload').click();

$('dropzone').ondragover = e => {
    e.preventDefault();
    $('dropzone').classList.add('dragover');
};

$('dropzone').ondragleave = () => {
    $('dropzone').classList.remove('dragover');
};

$('dropzone').ondrop = e => {
    e.preventDefault();
    $('dropzone').classList.remove('dragover');
    uploadFiles(e.dataTransfer.files);
};

$('close-preview').onclick = () => {
    const url = $('preview').dataset.url;
    if (url) URL.revokeObjectURL(url);
    $('preview').close();
};

updateBreadcrumb();


