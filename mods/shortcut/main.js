import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme } from "herdr";

export default class Shortcut extends View {
  init(_p, cx) {
    this.cx = cx;
  }
  keys() {}
  render() {
    return v_flex().id("shortcut").p(16).bg(theme().popover).child(div().child("Shortcut"));
  }
}
