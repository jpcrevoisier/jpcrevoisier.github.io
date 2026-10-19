class ScannerApp {
    constructor() {
        this.html5QrCode = null;
        this.lastScannedCode = null;
        this.destinationUrl = localStorage.getItem('destinationUrl') || '';
        
        this.initElements();
        this.initEventListeners();
        this.initScanner();
        this.loadSettings();
    }

    initElements() {
        this.settingsBtn = document.getElementById('settingsBtn');
        this.settingsModal = document.getElementById('settingsModal');
        this.scanModal = document.getElementById('scanModal');
        this.closeSettings = document.getElementById('closeSettings');
        this.closeScan = document.getElementById('closeScan');
        this.destinationUrlInput = document.getElementById('destinationUrl');
        this.saveSettingsBtn = document.getElementById('saveSettings');
        this.scannedCodeDisplay = document.getElementById('scannedCode');
        this.destinationLink = document.getElementById('destinationLink');
        this.openUrlBtn = document.getElementById('openUrl');
        this.copyUrlBtn = document.getElementById('copyUrl');
        this.statusDisplay = document.getElementById('status');
        this.lastCodeDisplay = document.getElementById('lastCode');
        this.clearBtn = document.getElementById('clearBtn');
    }

    initEventListeners() {
        this.settingsBtn.addEventListener('click', () => this.openSettings());
        this.closeSettings.addEventListener('click', () => this.closeSettingsModal());
        this.closeScan.addEventListener('click', () => this.closeScanModal());
        this.saveSettingsBtn.addEventListener('click', () => this.saveSettings());
        this.openUrlBtn.addEventListener('click', () => this.openUrl());
        this.copyUrlBtn.addEventListener('click', () => this.copyUrl());
        this.clearBtn.addEventListener('click', () => this.clearLastCode());

        window.addEventListener('click', (e) => {
            if (e.target === this.settingsModal) {
                this.closeSettingsModal();
            }
            if (e.target === this.scanModal) {
                this.closeScanModal();
            }
        });
    }

    async initScanner() {
        try {
            this.html5QrCode = new Html5Qrcode("reader");
            
            const config = {
                fps: 10,
                qrbox: { width: 250, height: 250 },
                aspectRatio: 1.0
            };

            await this.html5QrCode.start(
                { facingMode: "environment" },
                config,
                (decodedText) => this.onScanSuccess(decodedText),
                (errorMessage) => {
                    // Ignorer les erreurs de scan continu
                }
            );

            this.statusDisplay.textContent = 'Scanner actif - Pointez vers un code';
            this.statusDisplay.style.background = '#c8e6c9';
            this.statusDisplay.style.color = '#2e7d32';
        } catch (err) {
            this.statusDisplay.textContent = 'Erreur: ' + err.message;
            this.statusDisplay.style.background = '#ffcdd2';
            this.statusDisplay.style.color = '#c62828';
            console.error('Erreur d\'initialisation du scanner:', err);
        }
    }

    onScanSuccess(decodedText) {
        if (decodedText !== this.lastScannedCode) {
            this.lastScannedCode = decodedText;
            this.lastCodeDisplay.textContent = 'Dernier code: ' + decodedText;
            this.lastCodeDisplay.classList.add('active');
            this.showScanModal(decodedText);
        }
    }

    showScanModal(code) {
        this.scannedCodeDisplay.textContent = code;
        
        const finalUrl = this.destinationUrl 
            ? this.destinationUrl.replace('${code}', encodeURIComponent(code))
            : 'Aucune URL configurée';

        this.destinationLink.textContent = finalUrl;
        this.destinationLink.href = finalUrl;
        
        this.scanModal.classList.add('active');
    }

    openSettings() {
        this.destinationUrlInput.value = this.destinationUrl;
        this.settingsModal.classList.add('active');
    }

    closeSettingsModal() {
        this.settingsModal.classList.remove('active');
    }

    closeScanModal() {
        this.scanModal.classList.remove('active');
    }

    saveSettings() {
        this.destinationUrl = this.destinationUrlInput.value.trim();
        localStorage.setItem('destinationUrl', this.destinationUrl);
        this.closeSettingsModal();
        
        this.statusDisplay.textContent = 'Paramètres enregistrés';
        setTimeout(() => {
            this.statusDisplay.textContent = 'Scanner actif - Pointez vers un code';
        }, 2000);
    }

    loadSettings() {
        this.destinationUrl = localStorage.getItem('destinationUrl') || '';
    }

    openUrl() {
        const url = this.destinationLink.href;
        if (url && url !== '#' && url !== 'Aucune URL configurée') {
            window.open(url, '_blank');
            this.closeScanModal();
        }
    }

    copyUrl() {
        const url = this.destinationLink.textContent;
        if (url && url !== 'Aucune URL configurée') {
            navigator.clipboard.writeText(url).then(() => {
                this.copyUrlBtn.textContent = 'Copié !';
                setTimeout(() => {
                    this.copyUrlBtn.textContent = 'Copier l\'URL';
                }, 2000);
            }).catch(err => {
                console.error('Erreur de copie:', err);
            });
        }
    }

    clearLastCode() {
        this.lastScannedCode = null;
        this.lastCodeDisplay.classList.remove('active');
        this.statusDisplay.textContent = 'Dernier code effacé';
        setTimeout(() => {
            this.statusDisplay.textContent = 'Scanner actif - Pointez vers un code';
        }, 2000);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new ScannerApp();
});

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
        .then(reg => console.log('Service Worker enregistré avec succès'))
        .catch(err => console.error('Erreur Service Worker:', err));
}