# Privacy

Omarchy Mail is a personal mail client that runs only on your own computer.

- It signs in to Gmail and Outlook.com with OAuth and reads, marks and (later) sends your mail
  on your behalf, only when you use it.
- Your mail, its list rows and message sources are stored in a local SQLite file
  (`~/.local/share/omarchy-mail/`). Refresh tokens are stored in your desktop keyring.
- Nothing is sent to the author or to any third party. The app has no server of its own; it
  talks only to Google's and Microsoft's mail APIs, and, when you ask it to show remote images
  in a message, to the hosts those images come from.
- Remove an account in the app to delete its mail and tokens. Revoke access any time at
  https://myaccount.google.com/permissions or https://account.live.com/consent/Manage.

Questions: open an issue at https://github.com/lagz0ne/omarchy-mail/issues.
