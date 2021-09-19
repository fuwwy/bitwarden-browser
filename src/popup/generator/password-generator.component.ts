import { Location } from '@angular/common';
import { ChangeDetectorRef, Component, NgZone } from '@angular/core';

import { BrowserApi } from '../../browser/browserApi';

import { BroadcasterService } from 'jslib-angular/services/broadcaster.service';

import { I18nService } from 'jslib-common/abstractions/i18n.service';
import { PasswordGenerationService } from 'jslib-common/abstractions/passwordGeneration.service';
import { PlatformUtilsService } from 'jslib-common/abstractions/platformUtils.service';
import { StateService } from 'jslib-common/abstractions/state.service';

import { CipherType } from 'jslib-common/enums/cipherType';
import { CipherView } from 'jslib-common/models/view/cipherView';
import { LoginView } from 'jslib-common/models/view/loginView';

import {
    PasswordGeneratorComponent as BasePasswordGeneratorComponent,
} from 'jslib-angular/components/password-generator.component';

import { AutofillService } from '../../services/abstractions/autofill.service';
import { PopupUtilsService } from '../services/popup-utils.service';

const BroadcasterSubscriptionId = 'PasswordGeneratorComponent';

@Component({
    selector: 'app-password-generator',
    templateUrl: 'password-generator.component.html',
})
export class PasswordGeneratorComponent extends BasePasswordGeneratorComponent {
    private cipherState: CipherView;
    private pageDetails: any[] = [];
    private tab: any;

    constructor(passwordGenerationService: PasswordGenerationService, platformUtilsService: PlatformUtilsService,
        i18nService: I18nService, private stateService: StateService,
        private location: Location, private popupUtilsService: PopupUtilsService,
        private autofillService: AutofillService, private broadcasterService: BroadcasterService,
        private ngZone: NgZone, private changeDetectorRef: ChangeDetectorRef) {
        super(passwordGenerationService, platformUtilsService, i18nService, window);
    }

    async ngOnInit() {
        await super.ngOnInit();
        const addEditCipherInfo = await this.stateService.get<any>('addEditCipherInfo');
        if (addEditCipherInfo != null) {
            this.cipherState = addEditCipherInfo.cipher;
        }
        this.showSelect = this.cipherState != null || this.popupUtilsService.inOverlay(window);

        if (this.popupUtilsService.inOverlay(window)) {
            this.broadcasterService.subscribe(BroadcasterSubscriptionId, (message: any) => {
                this.ngZone.run(async () => {
                    switch (message.command) {
                        case 'collectPageDetailsResponse':
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

                    this.changeDetectorRef.detectChanges();
                });
            });

            this.tab = await BrowserApi.getTabFromCurrentWindow();
            if (!this.tab) return;
            BrowserApi.tabSendMessage(this.tab, {
                command: 'collectPageDetails',
                tab: this.tab,
                sender: BroadcasterSubscriptionId,
            });
        }
    }

    async select() {
        super.select();
        if (!this.popupUtilsService.inOverlay(window)) {
            this.cipherState.login.password = this.password;
        } else {
            const loginModel = new LoginView();
            loginModel.password = this.password;
            const model = new CipherView();
            model.type = CipherType.Login;
            model.login = loginModel;
            this.autofillService.doAutoFill({
                cipher: model,
                pageDetails: this.pageDetails,
                doc: window.document,
                fillNewPassword: true,
            });
        }
        this.close();
    }

    lengthChanged() {
        document.getElementById('length').focus();
    }

    close() {
        if (!this.popupUtilsService.inOverlay(window)) this.location.back();
        else BrowserApi.tabSendMessageData(this.tab, 'closeOverlays');
    }
}
