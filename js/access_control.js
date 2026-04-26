export function canAccessMentorReviewQueueState({ myRole, isMentorMode }) {
    return myRole === 'admin' || myRole === 'mentor' || isMentorMode === true;
}

export function isMentorViewingOtherJournalState({
    myRole,
    isMentorMode,
    userDocName,
    currentViewedUser,
}) {
    return !!(
        (isMentorMode || myRole === 'admin') &&
        userDocName &&
        currentViewedUser &&
        currentViewedUser !== userDocName
    );
}
