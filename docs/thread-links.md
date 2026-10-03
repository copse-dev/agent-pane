# Open a thread from GitHub

Enable **Settings → Agent → Thread links → Link commits and pull requests back to their Copse thread**. This is off by default and independent of co-author attribution.

Commits made with Copse's `git_commit` tool and pull requests created by Copse include:

```text
Copse-Thread: https://copse.dev/open/#thread=<thread-id>
```

Click the HTTPS link on GitHub, then **Open thread in Copse**. Your browser may ask permission to open the app. An installed packaged version of Copse registers `copse://thread/<thread-id>` with the operating system. Development runs do not change the system's protocol registration.

The client waits for project restoration before opening cold-launch links. Links received while it is running focus the main window and select the thread's stored project. A missing thread, an ambiguous owner, or a removed project shows a “Thread not found on this device” message instead.

Only the opaque thread ID is published. No transcript, local path, credentials or prompts are included. The HTTPS fragment is not sent in requests to the website server. Anyone can see the ID in a public commit, but opening it only works in a Copse profile that already stores that thread. Links cannot execute commands or start an agent run.

The website page must be deployed and the packaged client updated before links work end to end. Existing commits and manually created terminal commits are not retroactively changed.
