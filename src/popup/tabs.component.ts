import { Component, OnInit } from "@angular/core";

import { PopupUtilsService } from "./services/popup-utils.service";

@Component({
  selector: "app-tabs",
  templateUrl: "tabs.component.html",
})
export class TabsComponent implements OnInit {
  showTabs = true;
  showCurrentTab = true;

  constructor(private popupUtilsService: PopupUtilsService) {}

  ngOnInit() {
    this.showTabs = !this.popupUtilsService.inOverlay(window);
    this.showCurrentTab = !this.popupUtilsService.inPopout(window);
  }
}
