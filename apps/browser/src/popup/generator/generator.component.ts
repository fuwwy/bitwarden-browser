import { Location } from "@angular/common";
import { Component, NgZone } from "@angular/core";
import { ActivatedRoute } from "@angular/router";

import { GeneratorComponent as BaseGeneratorComponent } from "@bitwarden/angular/components/generator.component";
import { BroadcasterService } from "@bitwarden/common/abstractions/broadcaster.service";
import { I18nService } from "@bitwarden/common/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/abstractions/log.service";
import { PasswordGenerationService } from "@bitwarden/common/abstractions/passwordGeneration.service";
import { PlatformUtilsService } from "@bitwarden/common/abstractions/platformUtils.service";
import { StateService } from "@bitwarden/common/abstractions/state.service";
import { UsernameGenerationService } from "@bitwarden/common/abstractions/usernameGeneration.service";
import { CipherType } from "@bitwarden/common/enums/cipherType";
import { CipherView } from "@bitwarden/common/models/view/cipherView";
import { LoginView } from "@bitwarden/common/models/view/loginView";

import { BrowserApi } from "../../browser/browserApi";
import { AutofillService } from "../../services/abstractions/autofill.service";
import { PopupUtilsService } from "../services/popup-utils.service";

const BroadcasterSubscriptionId = "PasswordGeneratorComponent";

@Component({
  selector: "app-generator",
  templateUrl: "generator.component.html",
})
export class GeneratorComponent extends BaseGeneratorComponent {
  private addEditCipherInfo: any;
  private cipherState: CipherView;
  private pageDetails: any[] = [];
  private tab: any;

  constructor(
    passwordGenerationService: PasswordGenerationService,
    usernameGenerationService: UsernameGenerationService,
    platformUtilsService: PlatformUtilsService,
    i18nService: I18nService,
    stateService: StateService,
    route: ActivatedRoute,
    logService: LogService,
    private popupUtilsService: PopupUtilsService,
    private broadcasterService: BroadcasterService,
    private ngZone: NgZone,
    private autofillService: AutofillService,
    private location: Location
  ) {
    super(
      passwordGenerationService,
      usernameGenerationService,
      platformUtilsService,
      stateService,
      i18nService,
      logService,
      route,
      window
    );
  }

  async ngOnInit() {
    this.addEditCipherInfo = await this.stateService.getAddEditCipherInfo();
    if (this.addEditCipherInfo != null) {
      this.cipherState = this.addEditCipherInfo.cipher;
    }
    this.comingFromAddEdit = this.cipherState != null;
    this.comingFromOverlay = this.popupUtilsService.inOverlay(window);
    if (this.cipherState?.login?.hasUris) {
      this.usernameWebsite = this.cipherState.login.uris[0].hostname;
    }
    if (this.comingFromOverlay) {
      this.broadcasterService.subscribe(BroadcasterSubscriptionId, (message: any) => {
        this.ngZone.run(async () => {
          switch (message.command) {
            case "collectPageDetailsResponse":
              if (message.sender === BroadcasterSubscriptionId) {
                this.pageDetails.push({
                  frameId: message.webExtSender.frameId,
                  tab: message.tab,
                  details: message.details,
                });
              }
              break;
            default:
              break;
          }
        });
      });

      this.tab = await BrowserApi.getTabFromCurrentWindow();
      if (!this.tab) return;
      BrowserApi.tabSendMessage(this.tab, {
        command: "collectPageDetails",
        tab: this.tab,
        sender: BroadcasterSubscriptionId,
      });
    }
    await super.ngOnInit();
  }

  select() {
    super.select();
    if (!this.comingFromOverlay) {
      if (this.type === "password") {
        this.cipherState.login.password = this.password;
      } else if (this.type === "username") {
        this.cipherState.login.username = this.username;
      }
      this.addEditCipherInfo.cipher = this.cipherState;
      this.stateService.setAddEditCipherInfo(this.addEditCipherInfo);
    } else {
      const loginModel = new LoginView();
      if (this.type === "username") loginModel.username = this.username;
      else loginModel.password = this.password;
      const model = new CipherView();
      model.type = CipherType.Login;
      model.login = loginModel;
      this.autofillService.doAutoFill({
        cipher: model,
        pageDetails: this.pageDetails,
        tab: this.tab,
        fillNewPassword: true,
      });
    }
    this.close();
  }

  close() {
    if (this.comingFromOverlay) return BrowserApi.tabSendMessageData(this.tab, "closeOverlays");
    this.location.back();
  }
}
