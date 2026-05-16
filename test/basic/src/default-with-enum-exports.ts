export type ClientErrorReturnValue = { status: 400 | 403 | 404 | 406 };

export enum EvenRunStatus {
  NOT_EVEN = "not_even",
  EVEN_IN_HOUR = "even_in_hour",
  EVEN_IN_DAY = "even_in_day",
  EVEN_IN_DAY_AND_HOUR = "even_in_day_and_hour",
}

type Group = {
  (logUserId: number, userId: number, groupId: number): void;
};

export default Group;
