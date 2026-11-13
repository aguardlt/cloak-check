# Chrome Web Store: texts to paste

Developer Dashboard: https://chrome.google.com/webstore/devconsole

## Store listing tab

Category: Developer Tools
Language: English

Description:

CloakCheck shows whether a website serves the same page to people, to search engines and to AI crawlers.

Hacked websites often look normal to their owners. Injected casino or pharmacy pages are served only to Googlebot, or only to visitors who arrive from a search result. The owner learns about it from a traffic drop. CloakCheck makes the difference visible in one click.

What it does
• Requests the current page as a regular visitor, a visitor arriving from Google, Googlebot, Bingbot, GPTBot and ClaudeBot.
• Compares every response with the visitor version: HTTP status, text similarity, title, redirects to another domain, new external domains, spam vocabulary.
• Scans the open page for outbound links a visitor cannot see, hidden frames and obfuscated inline scripts.
• Gives a plain verdict and a report you can copy.

Who it is for
Site owners, SEO specialists, web developers and security people who need a quick first check of a suspicious site.

Limits
Only the User-Agent and Referer are changed. Requests still leave from your IP address, so malware that verifies crawler IP ranges will not be detected. A firewall that rejects fake crawler requests is reported as inconclusive, not as a problem. Findings are heuristics, not proof.

Privacy
Nothing is collected or sent anywhere. No server, no analytics, no remote code. Site access is requested per site, when you click the icon.

Open source: https://github.com/aguardlt/cloak-check

Images: store/screenshot-1-1280x800.png, store/screenshot-2-1280x800.png, store/promo-small-440x280.png, icon extension/icons/128.png

Homepage URL: https://aguard.lt
Support URL: https://github.com/aguardlt/cloak-check/issues

## Privacy tab

Single purpose:
Check whether a web page serves different content to search engine and AI crawlers than to regular visitors, and whether it contains hidden links.

activeTab justification:
The extension reads the address of the current tab when the user clicks the icon, so it knows which page to check.

scripting justification:
After the user clicks the icon, the extension runs one bundled function in the current tab to list outbound links that are not visible to a visitor. No remote code is executed.

declarativeNetRequestWithHostAccess justification:
The extension sets the User-Agent and Referer headers on its own test requests to the checked page, to see what a crawler receives. The rule is limited to requests made by the extension itself and never affects the user's browsing.

Host permission justification:
Host access is optional and requested per site at the moment of the check. It is needed to fetch the checked page with different request headers and to read the open tab for hidden links.

Remote code: No, I am not using remote code.

Data usage: tick nothing. Confirm all three certifications.

Privacy policy URL: https://github.com/aguardlt/cloak-check/blob/main/PRIVACY.md

## Distribution tab

Visibility: Public. Regions: all. Free.
