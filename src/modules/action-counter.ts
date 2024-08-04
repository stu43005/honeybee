import moment, { type Moment } from "moment-timezone";

export class ActionCounter {
  private handledActionCount: [time: Moment, count: number][] = [];

  // Add event
  public addActions(actions: number): void {
    this.handledActionCount.push([moment.tz("UTC"), actions]);
    this.cleanUpOldActions();
  }

  // Calculate the number of events in recent time
  public countRecentActions(duration: moment.Duration): number | null {
    const recentTime = moment.tz("UTC").subtract(duration);
    let count = 0;
    let hasEnoughData = false;

    for (const [time, actions] of this.handledActionCount) {
      if (time.isBefore(recentTime)) {
        hasEnoughData = true;
      }
      if (time.isAfter(recentTime)) {
        count += actions;
      }
    }

    if (hasEnoughData) {
      return count;
    }
    return null;
  }

  // Clear events that are over one minute old
  public cleanUpOldActions(): void {
    const removeBefore = moment.tz("UTC").subtract(15, "minute");
    this.handledActionCount = this.handledActionCount.filter(([time]) =>
      time.isAfter(removeBefore)
    );
  }
}
