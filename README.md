# bb-plugins

Plugins for [bb](https://getbb.app), maintained by Bit Complete.

| Plugin | What it does |
|---|---|
| [workstreams](plugins/workstreams) | Maps every git checkout you have in flight into a zoomable board of cross-repo efforts |
| [kubernetes-provider](plugins/kubernetes-provider) | Machine provider that runs each project on its own long-lived pod plus persistent volume in the bb server's namespace |
| [thread-briefs](plugins/thread-briefs) | Gives every thread a durable goal / current state / next step brief, summarized outside the working chat |
| [multi-repo](plugins/multi-repo) | Gives a project a set of git repos and every thread a workspace holding a checkout of each |
| [review-watch](plugins/review-watch) | Queues the GitHub pull requests that need your review and opens a thread for one when you press Start |

Install one:

```sh
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@main --plugin workstreams
```
