import moment, { type Moment } from "moment-timezone";

export class ActionCounter {
  private handledActionCount: [time: Moment, count: number][] = [];

  // Add event
  public addActions(actions: number) {
    this.handledActionCount.push([moment.tz("UTC"), actions]);
    this.cleanUpOldActions();
  }

  // Calculate the number of events in the last minute
  public countRecentActions() {
    const oneMinuteAgo = moment.tz("UTC").subtract(1, "minute");
    let count = 0;

    for (const [time, actions] of this.handledActionCount) {
      if (time.isAfter(oneMinuteAgo)) {
        count += actions;
      }
    }

    return count;
  }

  // Clear events that are over one minute old
  public cleanUpOldActions() {
    const oneMinuteAgo = moment.tz("UTC").subtract(1, "minute");
    this.handledActionCount = this.handledActionCount.filter(([time]) =>
      time.isAfter(oneMinuteAgo)
    );
  }
}
