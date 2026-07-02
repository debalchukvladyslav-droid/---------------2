export function canAccessMentorReviewQueueState({ myRole, isMentorMode }) {
    return myRole === 'mentor' || isMentorMode === true;
}

export function isViewingOtherProfileState({ userDocName, currentViewedUser }) {
    return !!(userDocName && currentViewedUser && currentViewedUser !== userDocName);
}

export function canWriteMentorCommentState({
    myRole,
    isMentorMode,
    userDocName,
    currentViewedUser,
}) {
    return !!(
        (isMentorMode || myRole === 'mentor') &&
        isViewingOtherProfileState({ userDocName, currentViewedUser })
    );
}

export function isMentorViewingOtherJournalState({
    myRole,
    isMentorMode,
    userDocName,
    currentViewedUser,
}) {
    return canWriteMentorCommentState({ myRole, isMentorMode, userDocName, currentViewedUser });
}
