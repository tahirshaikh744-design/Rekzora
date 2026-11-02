; ============================================================
; Rekzora — NSIS installer customizations (electron-builder include)
; Brand: NEURON TS LABS · Author: Mohd Tahir Shaikh
; ============================================================
; electron-builder includes this file into the generated installer
; script. For it to apply, nsis.include is configured as
; "build/installer.nsh" in package.json.
;
; Goal: enterprise-style license page where installation is impossible
; unless the user explicitly selects "I Agree" (radio buttons pattern
; used by enterprise installers).
; ============================================================

!ifndef REKZORA_NSIS_CUSTOM
#define REKZORA_NSIS_CUSTOM

; --- License page: radio buttons (I Agree / I Disagree) --------------
!define MUI_LICENSEPAGE_RADIOBUTTONS
!define MUI_LICENSEPAGE_RADIOBUTTONS_TEXT_ACCEPT "I Agree — I have read and accept the Privacy Policy and Terms of Use"
!define MUI_LICENSEPAGE_RADIOBUTTONS_TEXT_DECLINE "I Disagree — stop installation"

; --- Installer window branding ---------------------------------------
!define MUI_HEADERIMAGE_RIGHT
!define MUI_WELCOMEPAGE_TITLE "Welcome to the Rekzora Setup"
!define MUI_WELCOMEPAGE_TEXT "Rekzora — a beautiful, minimal, open-source screen recorder for Windows.$\r$\n$\r$\nPrivacy-first: Rekzora collects nothing, uploads nothing, and phones no home.$\r$\n$\r$\nPrepared by NEURON TS LABS (Mohd Tahir Shaikh)."

; --- Brand the uninstaller title -------------------------------------
!define MUI_UNWELCOMEPAGE_TITLE "Uninstall Rekzora"
!define MUI_UNWELCOMEPAGE_TEXT "This removes Rekzora from your computer.$\r$\n$\r$\nYour recordings stay untouched on your disk.$\r$\n$\r$\nNEURON TS LABS — Mohd Tahir Shaikh"

; --- Progressive "please wait" while elevating ------------------------
; (.onInit intentionally NOT defined here — electron-builder's template
;  already defines it; duplicates break the build.)

!endif ; REKZORA_NSIS_CUSTOM
