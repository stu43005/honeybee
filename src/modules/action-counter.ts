import moment, { type Moment } from "moment-timezone";

export class ActionCounter {
  private handledActionCount: [time: Moment, count: number][] = [];

  // Add event
  public addActions(actions: number) {
    this.handledActionCount.push([moment.tz("UTC"), actions]);
    this.cleanUpOldActions();
  }

  // Calculate the number of events in recent time
  public countRecentActions(duration: moment.Duration) {
    const recentTime = moment.tz("UTC").subtract(duration);
    let count = 0;

    for (const [time, actions] of this.handledActionCount) {
      if (time.isAfter(recentTime)) {
        count += actions;
      }
    }

    return count;
  }

  // Clear events that are over one minute old
  public cleanUpOldActions() {
    const removeBefore = moment.tz("UTC").subtract(10, "minute");
    this.handledActionCount = this.handledActionCount.filter(([time]) =>
      time.isAfter(removeBefore)
    );
  }
}
