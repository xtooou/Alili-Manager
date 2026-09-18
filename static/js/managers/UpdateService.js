import { modalManager } from './ModalManager.js';
import {
    getStorageItem,
    setStorageItem,
    getStoredVersionInfo,
    setStoredVersionInfo,
    isVersionMatch
} from '../utils/storageHelpers.js';
import { translate } from '../utils/i18nHelpers.js';

export class UpdateService {
    constructor() {
        this.updateCheckInterval = 60 * 60 * 1000; // 1 hour
        this.currentVersion = "v0.0.0";
        this.latestVersion = "v0.0.0";
        this.updateInfo = null;
        this.updateAvailable = false;
        this.gitInfo = {
            short_hash: "unknown",
            branch: "unknown",
            commit_date: "unknown"
        };
        this.updateNotificationsEnabled = getStorageItem('show_update_notifications', true);
        this.lastCheckTime = parseInt(getStorageItem('last_update_check') || '0');
        this.isUpdating = false;
        this.hasGit = false;
        this.currentVersionInfo = null;
        this.versionMismatch = false;
    }

    initialize() {
        const updateCheckbox = document.getElementById('updateNotifications');
        if (updateCheckbox) {
            updateCheckbox.checked = this.updateNotificationsEnabled;
            updateCheckbox.addEventListener('change', (e) => {
                this.updateNotificationsEnabled = e.target.checked;
                setStorageItem('show_update_notifications', e.target.checked);
                this.updateBadgeVisibility();
            });
        }

        const updateBtn = document.getElementById('updateBtn');
        if (updateBtn) {
            updateBtn.addEventListener('click', () => this.performUpdate());
        }

        this.checkVersionInfo().then(() => {
            this.checkForUpdates().then(() => {
                this.updateBadgeVisibility();
            });
        });

        this.updateModalContent();
    }

    formatRelativeTime(timestamp) {
        if (!timestamp) {
            return '';
        }

        const locale = window?.i18n?.getCurrentLocale?.() || navigator.language || 'en';

        try {
            const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
            const divisions = [
                { amount: 60, unit: 'second' },
                { amount: 60, unit: 'minute' },
                { amount: 24, unit: 'hour' },
                { amount: 7, unit: 'day' },
                { amount: 4.34524, unit: 'week' },
                { amount: 12, unit: 'month' },
                { amount: Infinity, unit: 'year' }
            ];

            let duration = (timestamp - Date.now()) / 1000;

            for (const division of divisions) {
                if (Math.abs(duration) < division.amount) {
                    return formatter.format(Math.round(duration), division.unit);
                }
                duration /= division.amount;
            }

            return formatter.format(Math.round(duration), 'year');
        } catch (error) {
            console.warn('RelativeTimeFormat not available, falling back to locale string.', error);
            return new Date(timestamp).toLocaleString(locale);
        }
    }

    async checkForUpdates({ force = false } = {}) {
        if (!force && !this.updateNotificationsEnabled) {
            return;
        }

        const now = Date.now();
        const forceCheck = force || this.lastCheckTime === 0;

        if (!forceCheck && now - this.lastCheckTime < this.updateCheckInterval) {
            if (this.updateAvailable) {
                this.updateBadgeVisibility();
            }
            return;
        }

        try {
            const response = await fetch('/api/lm/check-updates?nightly=false');
            const data = await response.json();

            if (data.success) {
                this.currentVersion = data.current_version || "v0.0.0";
                this.latestVersion = data.latest_version || "v0.0.0";
                this.updateInfo = data;
                this.gitInfo = data.git_info || this.gitInfo;
                this.hasGit = data.has_git || false;
                this.updateAvailable = data.update_available;

                this.lastCheckTime = now;
                setStorageItem('last_update_check', now.toString());

                this.updateBadgeVisibility();
                this.updateModalContent();

                console.log("Update check complete:", {
                    currentVersion: this.currentVersion,
                    latestVersion: this.latestVersion,
                    updateAvailable: this.updateAvailable,
                    gitInfo: this.gitInfo
                });
            }
        } catch (error) {
            console.error('Failed to check for updates:', error);
        }
    }

    updateBadgeVisibility() {
        const updateToggle = document.querySelector('.update-toggle');
        const updateBadge = document.querySelector('.update-toggle .update-badge');

        const shouldShowUpdate = this.updateNotificationsEnabled && this.updateAvailable;

        if (updateToggle) {
            const tooltipKey = shouldShowUpdate ? 'update.updateAvailable' : 'header.actions.notifications';
            updateToggle.title = translate(tooltipKey);
        }

        if (updateBadge) {
            updateBadge.classList.toggle('visible', shouldShowUpdate);
        }
    }

    updateModalContent() {
        const modal = document.getElementById('updateModal');
        if (!modal) return;

        const headerTitle = modal.querySelector('.update-header h2');
        if (headerTitle) {
            headerTitle.textContent = this.updateAvailable ?
                translate('update.updateAvailable') :
                translate('update.notificationsTitle');
        }

        const currentVersionEl = modal.querySelector('.current-version .version-number');
        const newVersionEl = modal.querySelector('.new-version .version-number');

        if (currentVersionEl) currentVersionEl.textContent = this.currentVersion;

        const newVersionLabel = modal.querySelector('.new-version .label');
        if (newVersionLabel) {
            newVersionLabel.textContent = `${translate('update.newVersion')}:`;
        }

        if (newVersionEl) {
            newVersionEl.textContent = this.latestVersion;
        }

        const updateBtn = modal.querySelector('#updateBtn');
        if (updateBtn) {
            updateBtn.classList.toggle('disabled', !this.updateAvailable || this.isUpdating);
            updateBtn.disabled = !this.updateAvailable || this.isUpdating;
        }

        const gitInfoEl = modal.querySelector('.git-info');
        if (gitInfoEl && this.gitInfo) {
            if (this.gitInfo.short_hash !== 'unknown') {
                let gitText = `${translate('update.commit')}: ${this.gitInfo.short_hash}`;
                if (this.gitInfo.commit_date !== 'unknown') {
                    gitText += ` - ${translate('common.status.date', {}, 'Date')}: ${this.gitInfo.commit_date}`;
                }
                gitInfoEl.textContent = gitText;
                gitInfoEl.style.display = 'block';
            } else {
                gitInfoEl.style.display = 'none';
            }
        }

        if (this.updateInfo && (this.updateInfo.changelog || this.updateInfo.releases)) {
            const changelogContent = modal.querySelector('.changelog-content');
            if (changelogContent) {
                changelogContent.innerHTML = '';

                const releases = this.updateInfo.releases;
                if (releases && Array.isArray(releases) && releases.length > 0) {
                    releases.forEach(release => {
                        const changelogItem = document.createElement('div');
                        changelogItem.className = 'changelog-item';
                        if (release.is_latest) {
                            changelogItem.classList.add('latest');
                        }

                        const versionHeader = document.createElement('h4');

                        if (release.is_latest) {
                            const badge = document.createElement('span');
                            badge.className = 'latest-badge';
                            badge.textContent = translate('update.latestBadge', {}, 'Latest');
                            versionHeader.appendChild(badge);
                            versionHeader.appendChild(document.createTextNode(' '));
                        }

                        const versionSpan = document.createElement('span');
                        versionSpan.className = 'version';
                        versionSpan.textContent = `${translate('common.status.version', {}, 'Version')} ${release.version}`;
                        versionHeader.appendChild(versionSpan);

                        if (release.published_at) {
                            const dateSpan = document.createElement('span');
                            dateSpan.className = 'publish-date';
                            dateSpan.textContent = this.formatRelativeTime(new Date(release.published_at).getTime());
                            versionHeader.appendChild(dateSpan);
                        }

                        changelogItem.appendChild(versionHeader);

                        const changelogList = document.createElement('ul');

                        if (release.changelog && release.changelog.length > 0) {
                            release.changelog.forEach(item => {
                                const listItem = document.createElement('li');
                                listItem.innerHTML = this.parseMarkdown(item);
                                changelogList.appendChild(listItem);
                            });
                        } else {
                            const listItem = document.createElement('li');
                            listItem.textContent = translate('update.noChangelogAvailable', {}, 'No detailed changelog available.');
                            changelogList.appendChild(listItem);
                        }

                        changelogItem.appendChild(changelogList);
                        changelogContent.appendChild(changelogItem);
                    });
                } else {
                    const changelogItem = document.createElement('div');
                    changelogItem.className = 'changelog-item';

                    const versionHeader = document.createElement('h4');
                    versionHeader.textContent = `${translate('common.status.version', {}, 'Version')} ${this.latestVersion}`;
                    changelogItem.appendChild(versionHeader);

                    const changelogList = document.createElement('ul');

                    if (this.updateInfo.changelog && this.updateInfo.changelog.length > 0) {
                        this.updateInfo.changelog.forEach(item => {
                            const listItem = document.createElement('li');
                            listItem.innerHTML = this.parseMarkdown(item);
                            changelogList.appendChild(listItem);
                        });
                    } else {
                        const listItem = document.createElement('li');
                        listItem.textContent = translate('update.noChangelogAvailable', {}, 'No detailed changelog available. Check GitHub for more information.');
                        changelogList.appendChild(listItem);
                    }

                    changelogItem.appendChild(changelogList);
                    changelogContent.appendChild(changelogItem);
                }
            }
        }

        const githubLink = modal.querySelector('.update-link');
        if (githubLink && this.latestVersion) {
            const versionTag = this.latestVersion.replace(/^v/, '');
            githubLink.href = `https://github.com/xtooou/Alili-Manager/releases/tag/v${versionTag}`;
        }
    }

    async performUpdate() {
        if (!this.updateAvailable || this.isUpdating) {
            return;
        }

        try {
            this.isUpdating = true;
            this.updateUpdateUI('updating', translate('update.status.updating'));
            this.showUpdateProgress(true);

            this.updateProgress(10, translate('update.updateProgress.preparing'));

            const response = await fetch('/api/lm/perform-update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    nightly: false
                })
            });

            this.updateProgress(50, translate('update.updateProgress.installing'));

            const data = await response.json();

            if (data.success) {
                this.updateProgress(100, translate('update.updateProgress.completed'));
                this.updateUpdateUI('success', translate('update.status.updated'));

                setTimeout(() => {
                    this.showUpdateCompleteMessage(data.new_version);
                }, 1000);

            } else {
                throw new Error(data.error || translate('update.status.updateFailed'));
            }

        } catch (error) {
            console.error('Update failed:', error);
            this.updateUpdateUI('error', translate('update.status.updateFailed'));
            this.updateProgress(0, translate('update.updateProgress.failed', { error: error.message }));

            setTimeout(() => {
                this.showUpdateProgress(false);
            }, 3000);
        } finally {
            this.isUpdating = false;
        }
    }

    updateUpdateUI(state, text) {
        const updateBtn = document.getElementById('updateBtn');
        const updateBtnText = document.getElementById('updateBtnText');

        if (updateBtn && updateBtnText) {
            updateBtn.classList.remove('updating', 'success', 'error', 'disabled');

            if (state !== 'normal') {
                updateBtn.classList.add(state);
            }

            updateBtnText.textContent = text;
            updateBtn.disabled = (state === 'updating' || state === 'disabled');
        }
    }

    showUpdateProgress(show) {
        const progressContainer = document.getElementById('updateProgress');
        if (progressContainer) {
            progressContainer.style.display = show ? 'block' : 'none';
        }
    }

    updateProgress(percentage, text) {
        const progressFill = document.getElementById('updateProgressFill');
        const progressText = document.getElementById('updateProgressText');

        if (progressFill) {
            progressFill.style.width = `${percentage}%`;
        }

        if (progressText) {
            progressText.textContent = text;
        }
    }

    showUpdateCompleteMessage(newVersion) {
        const modal = document.getElementById('updateModal');
        if (!modal) return;

        const progressText = document.getElementById('updateProgressText');
        if (progressText) {
            progressText.innerHTML = `
                <div style="text-align: center; color: var(--lora-success);">
                    <i class="fas fa-check-circle" style="margin-right: 8px;"></i>
                    ${translate('update.completion.successMessage', { version: newVersion })}
                    <br><br>
                    <div style="opacity: 0.95; color: var(--lora-error); font-size: 1em;">
                        ${translate('update.completion.restartMessage')}<br>
                        ${translate('update.completion.reloadMessage')}
                    </div>
                </div>
            `;
        }

        this.currentVersion = newVersion;
        this.updateAvailable = false;
    }

    parseMarkdown(text) {
        if (!text) return '';

        text = text.replace(/&/g, '&amp;');
        text = text.replace(/</g, '&lt;');
        text = text.replace(/>/g, '&gt;');

        text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
        text = text.replace(/`(.*?)`/g, '<code>$1</code>');
        text = text.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>');

        return text;
    }

    toggleUpdateModal() {
        const updateModal = modalManager.getModal('updateModal');

        if (updateModal && updateModal.isOpen) {
            modalManager.closeModal('updateModal');
            return;
        }

        this.updateModalContent();
        modalManager.showModal('updateModal');

        this.manualCheckForUpdates().then(() => {
            this.updateModalContent();
        });
    }

    async manualCheckForUpdates() {
        await this.checkForUpdates({ force: true });
        this.updateBadgeVisibility();
    }

    async checkVersionInfo() {
        try {
            const response = await fetch('/api/lm/version-info');
            const data = await response.json();

            if (data.success) {
                this.currentVersionInfo = data.version;
                this.hasGit = data.has_git || false;

                this.versionMismatch = !isVersionMatch(this.currentVersionInfo);

                if (this.versionMismatch) {
                    console.log('Version mismatch detected:', {
                        current: this.currentVersionInfo,
                        stored: getStoredVersionInfo()
                    });

                    setStoredVersionInfo(this.currentVersionInfo);
                }
            }
        } catch (error) {
            console.error('Failed to check version info:', error);
        }
    }
}

export const updateService = new UpdateService();