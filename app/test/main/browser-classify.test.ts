import { describe, expect, it } from "vitest";
import { consequentialAction, sensitiveField, type ElementFacts } from "../../src/main/browser/classify";

const f = (o: Partial<ElementFacts>): ElementFacts => ({ tag: "button", role: "button", name: "", type: "", inForm: false, formMethod: "get", formAction: "", isSubmit: false, searchForm: false, autocomplete: "", fieldHint: "", ...o });
const SHOP = "https://shop.example/cart";

describe("the consequential-action classifier", () => {
  it("flags buttons that pay, buy, send, post, delete or confirm", () => {
    for (const name of ["Pay now", "Buy", "Place order", "Send", "Post", "Delete account", "Confirm", "Publish", "Transfer $40", "Subscribe", "Check out"]) {
      expect(consequentialAction("click", f({ name }), SHOP), name).not.toBeNull();
    }
  });

  it("leaves ordinary navigation alone", () => {
    for (const name of ["Next page", "Docs", "Show more", "Accept cookies", "Add filter", "Search", "Sign out", "Back"]) {
      expect(consequentialAction("click", f({ role: "link", tag: "a", name }), SHOP), name).toBeNull();
    }
  });

  it("flags submitting a POST form, whatever the button says", () => {
    expect(consequentialAction("click", f({ name: "Continue", isSubmit: true, inForm: true, formMethod: "post", formAction: "https://site.example/profile" }), "https://site.example/profile")).not.toBeNull();
  });

  it("does not flag a GET search form", () => {
    expect(consequentialAction("click", f({ name: "Go", isSubmit: true, inForm: true, formMethod: "get", searchForm: true }), SHOP)).toBeNull();
    expect(consequentialAction("type", f({ tag: "input", role: "searchbox", type: "search", inForm: true, formMethod: "get", searchForm: true }), SHOP, { submit: true })).toBeNull();
  });

  it("flags typing + Enter (or pressing Enter) into a POST form's field", () => {
    const field = f({ tag: "input", role: "textbox", type: "text", inForm: true, formMethod: "post", formAction: "https://site.example/comment" });
    expect(consequentialAction("type", field, "https://site.example/p/1", { submit: true })).not.toBeNull();
    expect(consequentialAction("type", field, "https://site.example/p/1", { submit: false })).toBeNull();
    expect(consequentialAction("press", field, "https://site.example/p/1", { key: "Enter" })).not.toBeNull();
    expect(consequentialAction("press", field, "https://site.example/p/1", { key: "Tab" })).toBeNull();
  });

  it("flags any submit into a payment domain or checkout page", () => {
    expect(consequentialAction("click", f({ name: "Continue", isSubmit: true, inForm: true, formMethod: "get", formAction: "https://checkout.stripe.com/c/pay" }), SHOP)).not.toBeNull();
    expect(consequentialAction("click", f({ name: "Continue", isSubmit: true, inForm: true, formMethod: "get" }), "https://shop.example/checkout/payment")).not.toBeNull();
  });

  it("flags saving account settings", () => {
    expect(consequentialAction("click", f({ name: "Save changes" }), "https://site.example/settings/account")).not.toBeNull();
  });

  it("names the action and the site for the card", () => {
    expect(consequentialAction("click", f({ name: "Pay now" }), SHOP)).toBe("Click “Pay now”");
  });
});

describe("the password / payment field guard", () => {
  it("spots password fields", () => {
    expect(sensitiveField(f({ tag: "input", role: "textbox", type: "password" }))).toBe("password");
    expect(sensitiveField(f({ tag: "input", role: "textbox", type: "text", autocomplete: "current-password" }))).toBe("password");
  });

  it("spots payment-card fields by autocomplete or their label", () => {
    expect(sensitiveField(f({ tag: "input", role: "textbox", autocomplete: "cc-number" }))).toBe("card");
    expect(sensitiveField(f({ tag: "input", role: "textbox", autocomplete: "cc-csc" }))).toBe("card");
    for (const hint of ["Card number", "CVV", "Security code", "Expiry date (MM/YY)", "cardnumber"]) expect(sensitiveField(f({ tag: "input", role: "textbox", fieldHint: hint })), hint).toBe("card");
  });

  it("leaves ordinary fields alone", () => {
    for (const hint of ["Email", "Search", "Full name", "Address line 1", "Coupon code", "Gift card message"]) {
      expect(sensitiveField(f({ tag: "input", role: "textbox", type: "text", fieldHint: hint })), hint).toBeNull();
    }
  });
});

describe("found on the fixture site", () => {
  it("a checkbox labelled with a strong word is not a send (only buttons and links are judged by their words)", () => {
    expect(consequentialAction("click", f({ tag: "input", role: "checkbox", type: "checkbox", name: "Send me the newsletter", inForm: true, formMethod: "post" }), "https://site.example/signup")).toBeNull();
    expect(consequentialAction("click", f({ tag: "input", role: "radio", type: "radio", name: "Pay monthly", inForm: true, formMethod: "post" }), "https://site.example/signup")).toBeNull();
  });
});
