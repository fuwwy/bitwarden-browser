import { CipherService } from "jslib-common/abstractions/cipher.service";
import { FolderService } from "jslib-common/abstractions/folder.service";
import { PolicyService } from "jslib-common/abstractions/policy.service";
import { VaultTimeoutService } from "jslib-common/abstractions/vaultTimeout.service";
import { CipherType } from "jslib-common/enums/cipherType";
import { PolicyType } from "jslib-common/enums/policyType";
import { Utils } from "jslib-common/misc/utils";
import { CipherView } from "jslib-common/models/view/cipherView";
import { LoginUriView } from "jslib-common/models/view/loginUriView";
import { LoginView } from "jslib-common/models/view/loginView";

import { BrowserApi } from "../browser/browserApi";
import { StateService } from "../services/abstractions/state.service";

import AddChangePasswordQueueMessage from "./models/addChangePasswordQueueMessage";
import AddLoginQueueMessage from "./models/addLoginQueueMessage";
import AddLoginRuntimeMessage from "./models/addLoginRuntimeMessage";
import ChangePasswordRuntimeMessage from "./models/changePasswordRuntimeMessage";
import LockedVaultPendingNotificationsItem from "./models/lockedVaultPendingNotificationsItem";
import { NotificationQueueMessageType } from "./models/notificationQueueMessageType";

export default class NotificationBackground {
  private notificationQueue: (AddLoginQueueMessage | AddChangePasswordQueueMessage)[] = [];
  private usernameCache: any[] = [];

  constructor(
    private cipherService: CipherService,
    private vaultTimeoutService: VaultTimeoutService,
    private policyService: PolicyService,
    private folderService: FolderService,
    private stateService: StateService
  ) {}

  async init() {
    if (chrome.runtime == null) {
      return;
    }

    BrowserApi.messageListener(
      "notification.background",
      async (msg: any, sender: chrome.runtime.MessageSender) => {
        await this.processMessage(msg, sender);
      }
    );

    this.cleanupNotificationQueue();
  }

  async processMessage(msg: any, sender: chrome.runtime.MessageSender) {
    switch (msg.command) {
      case "unlockCompleted":
        if (msg.data.target !== "notification.background") {
          return;
        }
        await this.processMessage(msg.data.commandToRetry.msg, msg.data.commandToRetry.sender);
        break;
      case "bgGetDataForTab":
        await this.getDataForTab(sender.tab, msg.responseCommand);
        break;
      case "bgCloseNotificationBar":
        await BrowserApi.tabSendMessageData(sender.tab, "closeNotificationBar");
        break;
      case "bgAdjustNotificationBar":
        await BrowserApi.tabSendMessageData(sender.tab, "adjustNotificationBar", msg.data);
        break;
      case "bgAddLogin":
        await this.addLogin(msg.login, sender.tab);
        break;
      case "bgChangedPassword":
        await this.changedPassword(msg.data, sender.tab);
        break;
      case "bgAddClose":
      case "bgChangeClose":
        this.removeTabFromNotificationQueue(sender.tab);
        break;
      case "bgAddSave":
      case "bgChangeSave":
        if (await this.vaultTimeoutService.isLocked()) {
          const retryMessage: LockedVaultPendingNotificationsItem = {
            commandToRetry: {
              msg: msg,
              sender: sender,
            },
            target: "notification.background",
          };
          await BrowserApi.tabSendMessageData(
            sender.tab,
            "addToLockedVaultPendingNotifications",
            retryMessage
          );
          await BrowserApi.tabSendMessageData(sender.tab, "promptForLogin");
          return;
        }
        await this.saveOrUpdateCredentials(sender.tab, msg.folder);
        break;
      case "bgNeverSave":
        await this.saveNever(sender.tab);
        break;
      case "formSubmission":
        this.handleFormSubmission(sender.tab, msg.data);
        break;
      case "requestAvailableCiphers": {
        const ciphers = await this.cipherService.getAllDecryptedForUrl(sender.tab.url);
        await BrowserApi.tabSendMessageData(sender.tab, "availableCiphers", {
          ciphers: ciphers.length,
          usernameCiphers: ciphers.filter((cipher) => cipher.login && cipher.login.username).length,
          passwordCiphers: ciphers.filter((cipher) => cipher.login && cipher.login.password).length,
        });
        break;
      }
      default:
        break;
    }
  }

  async checkNotificationQueue(tab: chrome.tabs.Tab = null): Promise<void> {
    if (this.notificationQueue.length === 0) {
      return;
    }

    if (tab != null) {
      this.doNotificationQueueCheck(tab);
      return;
    }

    const currentTab = await BrowserApi.getTabFromCurrentWindow();
    if (currentTab != null) {
      this.doNotificationQueueCheck(currentTab);
    }
  }

  private cleanupNotificationQueue() {
    for (let i = this.notificationQueue.length - 1; i >= 0; i--) {
      if (this.notificationQueue[i].expires < new Date()) {
        this.notificationQueue.splice(i, 1);
      }
    }
    setTimeout(() => this.cleanupNotificationQueue(), 2 * 60 * 1000); // check every 2 minutes
  }

  private doNotificationQueueCheck(tab: chrome.tabs.Tab): void {
    if (tab == null) {
      return;
    }

    const tabDomain = Utils.getDomain(tab.url);
    if (tabDomain == null) {
      return;
    }

    for (let i = 0; i < this.notificationQueue.length; i++) {
      if (
        this.notificationQueue[i].tabId !== tab.id ||
        this.notificationQueue[i].domain !== tabDomain
      ) {
        continue;
      }

      if (this.notificationQueue[i].type === NotificationQueueMessageType.AddLogin) {
        BrowserApi.tabSendMessageData(tab, "openNotificationBar", {
          type: "add",
          typeData: {
            isVaultLocked: this.notificationQueue[i].wasVaultLocked,
          },
        });
      } else if (this.notificationQueue[i].type === NotificationQueueMessageType.ChangePassword) {
        BrowserApi.tabSendMessageData(tab, "openNotificationBar", {
          type: "change",
          typeData: {
            isVaultLocked: this.notificationQueue[i].wasVaultLocked,
          },
        });
      }
      break;
    }
  }

  private removeTabFromNotificationQueue(tab: chrome.tabs.Tab) {
    for (let i = this.notificationQueue.length - 1; i >= 0; i--) {
      if (this.notificationQueue[i].tabId === tab.id) {
        this.notificationQueue.splice(i, 1);
      }
    }
  }

  private async handleFormSubmission(
    tab: any,
    formData: {
      url: string;
      fields: any[];
      username?: string;
      password?: string;
      originalPassword?: string;
      isPasswordChange?: boolean;
    }
  ) {
    const ciphers = await this.cipherService.getAllDecryptedForUrl(formData.url);
    const passwordFields = formData.fields.filter((field) => field.type === "password");
    const usernameFields = formData.fields.filter(
      (field) => field.type === "email" || field.type === "text"
    );
    const mainUsernameField =
      formData.fields.filter((field) => field.attributes.includes("email"))[0] || usernameFields[0];

    if (passwordFields.length === 0) {
      if (!mainUsernameField) return;

      return this.usernameCache.push({
        url: Utils.getDomain(formData.url),
        username: mainUsernameField.value,
        time: Date.now(),
      });
    }

    if (mainUsernameField && mainUsernameField.value) formData.username = mainUsernameField.value;
    else {
      const cachedUsernames = this.usernameCache.filter(
        (cachedUsername) =>
          cachedUsername.time > Date.now() - 60000 &&
          cachedUsername.url === Utils.getDomain(formData.url)
      );
      formData.username = cachedUsernames.sort((a, b) => a.time - b.time)[0]?.username;
    }

    const passwordValues = Array.from(new Set(passwordFields.map((field) => field.value)));
    if (passwordValues.length === 1) {
      if (passwordFields.length === 2 && formData.fields.length === 2)
        formData.isPasswordChange = true;
      formData.password = passwordValues[0];
    } else {
      passwordValues.forEach((password) => {
        const passwordMatches = ciphers.filter(
          (c) =>
            (!formData.username || c.login.username === formData.username.toLowerCase()) &&
            c.login.password === password
        );
        if (passwordMatches) {
          formData.originalPassword = password;
          formData.password = passwordValues.find((value) => value !== password);
        } else if (
          passwordValues.length === 2 &&
          passwordFields.filter((field) => field.value === password).length > 1
        ) {
          formData.originalPassword = passwordValues.find((value) => value !== password);
          formData.password = password;
        }
      });
    }
    if (!formData.password) formData.password = passwordValues[0];

    if (formData.isPasswordChange || formData.originalPassword) {
      this.changedPassword(
        {
          username: formData.username,
          newPassword: formData.password,
          currentPassword: formData.originalPassword,
          url: formData.url,
        },
        tab
      );
    } else {
      this.addLogin(
        {
          username: formData.username,
          password: formData.password,
          url: formData.url,
        },
        tab
      );
    }
    this.usernameCache = this.usernameCache.filter(
      (cachedUsername) => cachedUsername.time > Date.now() - 60000
    );
  }

  private async addLogin(loginInfo: AddLoginRuntimeMessage, tab: chrome.tabs.Tab) {
    if (!(await this.stateService.getIsAuthenticated())) {
      return;
    }

    const loginDomain = Utils.getDomain(loginInfo.url);
    if (loginDomain == null) {
      return;
    }

    let normalizedUsername = loginInfo.username;
    if (normalizedUsername != null) {
      normalizedUsername = normalizedUsername.toLowerCase();
    }

    const disabledAddLogin = await this.stateService.getDisableAddLoginNotification();
    if (await this.vaultTimeoutService.isLocked()) {
      if (disabledAddLogin) {
        return;
      }

      if (!(await this.allowPersonalOwnership())) {
        return;
      }

      this.pushAddLoginToQueue(loginDomain, loginInfo, tab, true);
      return;
    }

    const ciphers = await this.cipherService.getAllDecryptedForUrl(loginInfo.url);
    const usernameMatches = ciphers.filter(
      (c) => c.login.username != null && c.login.username.toLowerCase() === normalizedUsername
    );
    if (usernameMatches.length === 0) {
      if (disabledAddLogin) {
        return;
      }

      if (!(await this.allowPersonalOwnership())) {
        return;
      }

      this.pushAddLoginToQueue(loginDomain, loginInfo, tab);
    } else if (
      usernameMatches.length === 1 &&
      usernameMatches[0].login.password !== loginInfo.password
    ) {
      const disabledChangePassword =
        await this.stateService.getDisableChangedPasswordNotification();
      if (disabledChangePassword) {
        return;
      }
      this.pushChangePasswordToQueue(usernameMatches[0].id, loginDomain, loginInfo.password, tab);
    }
  }

  private async pushAddLoginToQueue(
    loginDomain: string,
    loginInfo: AddLoginRuntimeMessage,
    tab: chrome.tabs.Tab,
    isVaultLocked = false
  ) {
    // remove any old messages for this tab
    this.removeTabFromNotificationQueue(tab);
    const message: AddLoginQueueMessage = {
      type: NotificationQueueMessageType.AddLogin,
      username: loginInfo.username,
      password: loginInfo.password,
      domain: loginDomain,
      uri: loginInfo.url,
      tabId: tab.id,
      expires: new Date(new Date().getTime() + 5 * 60000), // 5 minutes
      wasVaultLocked: isVaultLocked,
    };
    this.notificationQueue.push(message);
    await this.checkNotificationQueue(tab);
  }

  private async changedPassword(changeData: ChangePasswordRuntimeMessage, tab: chrome.tabs.Tab) {
    const loginDomain = Utils.getDomain(changeData.url);
    if (loginDomain == null) {
      return;
    }

    if (await this.vaultTimeoutService.isLocked()) {
      this.pushChangePasswordToQueue(null, loginDomain, changeData.newPassword, tab, true);
      return;
    }

    let id: string = null;
    const ciphers = await this.cipherService.getAllDecryptedForUrl(changeData.url);
    if (changeData.currentPassword != null) {
      const passwordMatches = ciphers.filter(
        (c) => c.login.password === changeData.currentPassword
      );
      if (passwordMatches.length === 1) {
        id = passwordMatches[0].id;
      } else if (changeData.username) {
        const usernameMatches = passwordMatches.filter(
          (c) => c.login.username === changeData.username
        );
        if (usernameMatches.length === 1) {
          id = usernameMatches[0].id;
        }
      }
    } else if (ciphers.length === 1) {
      id = ciphers[0].id;
    }
    if (id != null) {
      this.pushChangePasswordToQueue(id, loginDomain, changeData.newPassword, tab);
    }
  }

  private async pushChangePasswordToQueue(
    cipherId: string,
    loginDomain: string,
    newPassword: string,
    tab: chrome.tabs.Tab,
    isVaultLocked = false
  ) {
    // remove any old messages for this tab
    this.removeTabFromNotificationQueue(tab);
    const message: AddChangePasswordQueueMessage = {
      type: NotificationQueueMessageType.ChangePassword,
      cipherId: cipherId,
      newPassword: newPassword,
      domain: loginDomain,
      tabId: tab.id,
      expires: new Date(new Date().getTime() + 5 * 60000), // 5 minutes
      wasVaultLocked: isVaultLocked,
    };
    this.notificationQueue.push(message);
    await this.checkNotificationQueue(tab);
  }

  private async saveOrUpdateCredentials(tab: chrome.tabs.Tab, folderId?: string) {
    for (let i = this.notificationQueue.length - 1; i >= 0; i--) {
      const queueMessage = this.notificationQueue[i];
      if (
        queueMessage.tabId !== tab.id ||
        (queueMessage.type !== NotificationQueueMessageType.AddLogin &&
          queueMessage.type !== NotificationQueueMessageType.ChangePassword)
      ) {
        continue;
      }

      const tabDomain = Utils.getDomain(tab.url);
      if (tabDomain != null && tabDomain !== queueMessage.domain) {
        continue;
      }

      this.notificationQueue.splice(i, 1);
      BrowserApi.tabSendMessageData(tab, "closeNotificationBar");

      if (queueMessage.type === NotificationQueueMessageType.ChangePassword) {
        const changePasswordMessage = queueMessage as AddChangePasswordQueueMessage;
        const cipher = await this.getDecryptedCipherById(changePasswordMessage.cipherId);
        if (cipher == null) {
          return;
        }
        await this.updateCipher(cipher, changePasswordMessage.newPassword);
        return;
      }

      if (queueMessage.type === NotificationQueueMessageType.AddLogin) {
        if (!queueMessage.wasVaultLocked) {
          await this.createNewCipher(queueMessage as AddLoginQueueMessage, folderId);
          BrowserApi.tabSendMessageData(tab, "addedCipher");
          return;
        }

        // If the vault was locked, check if a cipher needs updating instead of creating a new one
        const addLoginMessage = queueMessage as AddLoginQueueMessage;
        const ciphers = await this.cipherService.getAllDecryptedForUrl(addLoginMessage.uri);
        const usernameMatches = ciphers.filter(
          (c) =>
            c.login.username != null && c.login.username.toLowerCase() === addLoginMessage.username
        );

        if (usernameMatches.length >= 1) {
          await this.updateCipher(usernameMatches[0], addLoginMessage.password);
          return;
        }

        await this.createNewCipher(addLoginMessage, folderId);
        BrowserApi.tabSendMessageData(tab, "addedCipher");
      }
    }
  }

  private async createNewCipher(queueMessage: AddLoginQueueMessage, folderId: string) {
    const loginModel = new LoginView();
    const loginUri = new LoginUriView();
    loginUri.uri = queueMessage.uri;
    loginModel.uris = [loginUri];
    loginModel.username = queueMessage.username;
    loginModel.password = queueMessage.password;
    const model = new CipherView();
    model.name = Utils.getHostname(queueMessage.uri) || queueMessage.domain;
    model.name = model.name.replace(/^www\./, "");
    model.type = CipherType.Login;
    model.login = loginModel;

    if (!Utils.isNullOrWhitespace(folderId)) {
      const folders = await this.folderService.getAllDecrypted();
      if (folders.some((x) => x.id === folderId)) {
        model.folderId = folderId;
      }
    }

    const cipher = await this.cipherService.encrypt(model);
    await this.cipherService.saveWithServer(cipher);
  }

  private async getDecryptedCipherById(cipherId: string) {
    const cipher = await this.cipherService.get(cipherId);
    if (cipher != null && cipher.type === CipherType.Login) {
      return await cipher.decrypt();
    }
    return null;
  }

  private async updateCipher(cipher: CipherView, newPassword: string) {
    if (cipher != null && cipher.type === CipherType.Login) {
      cipher.login.password = newPassword;
      const newCipher = await this.cipherService.encrypt(cipher);
      await this.cipherService.saveWithServer(newCipher);
    }
  }

  private async saveNever(tab: chrome.tabs.Tab) {
    for (let i = this.notificationQueue.length - 1; i >= 0; i--) {
      const queueMessage = this.notificationQueue[i];
      if (
        queueMessage.tabId !== tab.id ||
        queueMessage.type !== NotificationQueueMessageType.AddLogin
      ) {
        continue;
      }

      const tabDomain = Utils.getDomain(tab.url);
      if (tabDomain != null && tabDomain !== queueMessage.domain) {
        continue;
      }

      this.notificationQueue.splice(i, 1);
      BrowserApi.tabSendMessageData(tab, "closeNotificationBar");

      const hostname = Utils.getHostname(tab.url);
      await this.cipherService.saveNeverDomain(hostname);
    }
  }

  private async getDataForTab(tab: chrome.tabs.Tab, responseCommand: string) {
    const responseData: any = {};
    if (responseCommand === "notificationBarGetFoldersList") {
      responseData.folders = await this.folderService.getAllDecrypted();
    }

    await BrowserApi.tabSendMessageData(tab, responseCommand, responseData);
  }

  private async allowPersonalOwnership(): Promise<boolean> {
    return !(await this.policyService.policyAppliesToUser(PolicyType.PersonalOwnership));
  }
}
