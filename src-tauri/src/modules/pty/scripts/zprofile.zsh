# puhon-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _puhon_user_zdotdir="${PUHON_USER_ZDOTDIR:-$HOME}"
  [ -f "$_puhon_user_zdotdir/.zprofile" ] && source "$_puhon_user_zdotdir/.zprofile"
  unset _puhon_user_zdotdir
}
:
